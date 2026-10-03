import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { firebaseConfig } from "./firebase-config/firebase-config.js";
import {
    getFirestore,
    collection,
    query,
    where,
    limit,
    onSnapshot,
    addDoc,
    updateDoc,
    deleteDoc,
    doc,
    getDoc,
    getDocs,
    serverTimestamp,
    writeBatch,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";

let app, db;
try {
    app = initializeApp(firebaseConfig);
    db = getFirestore(app);
} catch (initErr) {
    // Boot-loader safety (mirrored from Resident Hub): never trap the user
    // behind the loading overlay if Firebase cannot initialize.
    console.error(
        "Firebase initialization failed — check firebase-config/firebase-config.js",
        initErr,
    );
    const releaseOverlay = () =>
        document
            .getElementById("page-loading-overlay")
            ?.classList.remove("active");
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", releaseOverlay);
    } else {
        releaseOverlay();
    }
    throw initErr;
}

const STATUS = Object.freeze({
    PENDING: "Pending",
    APPROVED: "Approved",
    CONFIRMED: "Confirmed",
    REJECTED: "Rejected",
    REGISTERED: "Registered",
    COMPLETED: "Completed",
    CANCELLED: "Cancelled",
    TRASHED: "Trashed",
});

/**
 * REJECTION BUG FIX (mirrored from Resident Hub): status values stored by
 * different panels/legacy records may vary in capitalization or wording
 * ("rejected", "Declined", paymentStatus-only updates…). All status
 * comparisons now funnel through this normalizer so records never get stuck
 * in the wrong bucket.
 */
function normalizeStatus(rawValue) {
    const s = String(rawValue ?? "")
        .trim()
        .toLowerCase();
    if (
        [
            "approved",
            "approve",
            "confirmed",
            "confirm",
            "completed",
            "complete",
            "verified",
            "success",
            "successful",
            "accepted",
            "accept",
        ].includes(s)
    )
        return STATUS.APPROVED;
    if (
        [
            "rejected",
            "reject",
            "declined",
            "decline",
            "denied",
            "deny",
            "failed",
            "invalid",
        ].includes(s)
    )
        return STATUS.REJECTED;
    return STATUS.PENDING;
}

/** Resolve the effective decision status of a record (honors paymentStatus
 *  when the primary status field was left pending). */
function effectiveStatus(data) {
    const primary = normalizeStatus(data?.status);
    if (primary !== STATUS.PENDING) return primary;
    if (data?.paymentStatus !== undefined && data?.paymentStatus !== null) {
        const secondary = normalizeStatus(data.paymentStatus);
        if (secondary !== STATUS.PENDING) return secondary;
    }
    return STATUS.PENDING;
}

/**
 * SLOW INTERNET BUFFER (mirrored from Resident Hub): retries a Firestore
 * read with exponential backoff so one dropped packet doesn't end the
 * organizer session on refresh.
 */
async function withRetryBuffer(taskFn, options = {}) {
    const { retries = 3, baseDelay = 1200, label = "firestore" } = options;
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await taskFn();
        } catch (err) {
            lastErr = err;
            if (attempt < retries) {
                const wait = baseDelay * Math.pow(1.6, attempt);
                console.warn(
                    `[retry-buffer] ${label} attempt ${attempt + 1} failed, retrying in ${Math.round(wait)}ms…`,
                    err?.code || err?.message || err,
                );
                await new Promise((r) => setTimeout(r, wait));
            }
        }
    }
    throw lastErr;
}

// ===== BOOT LOADER (slow-internet aware, mirrored from Resident Hub) =====
let bootLoaderSlowTimer = null,
    bootLoaderFailsafeTimer = null,
    bootLoaderDone = false;

function showBootLoader() {
    const overlay = document.getElementById("page-loading-overlay");
    if (!overlay || bootLoaderDone) return;
    overlay.classList.add("active");
    bootLoaderSlowTimer = setTimeout(() => {
        const sub = overlay.querySelectorAll("p")[1];
        if (sub)
            sub.innerHTML =
                '<i class="fa-solid fa-wifi mr-1"></i>Slow connection detected — still retrieving your data, please wait…';
    }, 8000);
    bootLoaderFailsafeTimer = setTimeout(() => hideBootLoader(), 25000);
}

function hideBootLoader() {
    bootLoaderDone = true;
    if (bootLoaderSlowTimer) clearTimeout(bootLoaderSlowTimer);
    if (bootLoaderFailsafeTimer) clearTimeout(bootLoaderFailsafeTimer);
    document.getElementById("page-loading-overlay")?.classList.remove("active");
}

const SESSION_KEY = "victoriaOrganizerSession";
const TAB_KEY = "victoriaOrganizerActiveTab";
const ALLOWED_TABS = Object.freeze([
    "announcements",
    "events",
    "volunteers",
    "hours",
    "donations",
]);
const TAB_TITLES = Object.freeze({
    announcements: "Announcements",
    events: "Events",
    volunteers: "Volunteers",
    hours: "Service Hours",
    donations: "Donations",
});

const state = {
    session: null,
    unsubscribers: [],
    events: [],
    announcements: [],
    volunteers: [],
    donations: [],
    participants: [],
    serviceHours: [],
    activeTab: "announcements",
    activityFilter: "all",
    editEventExistingImage: "",
    editEventExistingImageName: "",
    editAnnouncementExistingImage: "",
    editAnnouncementExistingImageName: "",
    editAnnouncementExistingImageSource: "",
};

let confirmResolver = null;
let initialized = false;

const $ = (id) => document.getElementById(id);

function newChipHtml() {
    return '<span class="item-new-chip">NEW</span>';
}

function updateNavBadge(tabId, count) {
    const badge = document.getElementById("badge-" + tabId);
    if (!badge) return;
    const n = Number(count) || 0;
    if (n > 0) {
        badge.textContent = n > 99 ? "99+" : String(n);
        badge.classList.remove("hidden");
        badge.setAttribute("aria-hidden", "false");
    } else {
        badge.textContent = "0";
        badge.classList.add("hidden");
        badge.setAttribute("aria-hidden", "true");
    }
}

function getNewEventJoins() {
    return state.participants.filter(
        (participant) =>
            String(participant.status || STATUS.REGISTERED) === STATUS.REGISTERED,
    );
}

function renderNewEventJoinsPanel() {
    const panel = $("new-event-joins-panel");
    const list = $("new-event-joins-list");
    const countEl = $("new-event-joins-count");
    if (!panel || !list) return;
    const joins = getNewEventJoins()
        .slice()
        .sort(
            (a, b) =>
                timestampToMillis(participantTimestamp(b) || b.timestamp || b.createdAt) -
                timestampToMillis(participantTimestamp(a) || a.timestamp || a.createdAt),
        );
    if (!joins.length) {
        panel.classList.add("hidden");
        list.innerHTML = "";
        return;
    }
    panel.classList.remove("hidden");
    if (countEl) countEl.textContent = `${joins.length} new`;
    list.innerHTML = joins
        .map((log) => {
            const when = formatTimestamp(
                log.timestamp || log.createdAt,
                "Just now",
            );
            return `<div class="flex items-center justify-between gap-3 bg-white border border-amber-200 rounded-xl px-3.5 py-2.5">
        <div class="min-w-0">
          <p class="text-sm font-bold text-slate-900 truncate">${escapeHtml(log.residentName || "Resident")}</p>
          <p class="text-xs text-slate-500 truncate">joined <span class="font-semibold text-victoria-blue">${escapeHtml(log.eventTitle || "an event")}</span></p>
        </div>
        <div class="text-right shrink-0">
          ${newChipHtml()}
          <p class="text-[10px] text-slate-400 mt-1">${escapeHtml(when)}</p>
        </div>
      </div>`;
        })
        .join("");
}

function refreshActionBadges() {
    const pendingVolunteers = state.volunteers.filter(
        (volunteer) => String(volunteer.status || STATUS.PENDING) === STATUS.PENDING,
    ).length;
    const pendingDonations = state.donations.filter(
        (donation) => String(donation.status || STATUS.PENDING) === STATUS.PENDING,
    ).length;
    updateNavBadge("volunteers", pendingVolunteers);
    updateNavBadge("donations", pendingDonations);
    updateNavBadge("hours", getNewEventJoins().length);
    renderNewEventJoinsPanel();
}


function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function safeWebUrl(value) {
    if (!value) return "";
    try {
        const parsed = new URL(String(value), window.location.href);
        return parsed.protocol === "http:" || parsed.protocol === "https:"
            ? parsed.href
            : "";
    } catch {
        return "";
    }
}

function safeImageUrl(value) {
    const url = String(value || "");
    if (/^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=\s]+$/i.test(url))
        return url;
    return safeWebUrl(url);
}

function safeFileUrl(value) {
    const url = String(value || "");
    if (/^(data:|blob:|https?:)/i.test(url)) return url;
    return "";
}

function timestampToMillis(value) {
    if (!value) return 0;
    if (typeof value.toMillis === "function") return value.toMillis();
    if (typeof value.toDate === "function") return value.toDate().getTime();
    if (typeof value.seconds === "number") return value.seconds * 1000;
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
}

function formatTimestamp(value, fallback = "Not available") {
    const milliseconds = timestampToMillis(value);
    if (!milliseconds) return fallback;
    return new Intl.DateTimeFormat("en-PH", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    }).format(new Date(milliseconds));
}

function formatEventDate(dateValue) {
    if (!dateValue) return "Date to be announced";
    const date = new Date(`${dateValue}T00:00:00`);
    if (Number.isNaN(date.getTime())) return String(dateValue);
    return new Intl.DateTimeFormat("en-PH", {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
    }).format(date);
}

function formatTime(timeValue) {
    if (!timeValue) return "";
    const match = String(timeValue).match(/^(\d{1,2}):(\d{2})/);
    if (!match) return String(timeValue);
    const date = new Date();
    date.setHours(Number(match[1]), Number(match[2]), 0, 0);
    return new Intl.DateTimeFormat("en-PH", {
        hour: "numeric",
        minute: "2-digit",
    }).format(date);
}

function getDisplayName() {
    return state.session?.name || state.session?.email || "Event Organizer";
}

/**
 * A document in the Firestore `organizers` collection represents an organizer
 * account.  This project does not require a separate `role` field: an account
 * can sign in when its stored email and password match and it is not disabled.
 */
function isActiveOrganizer(profile) {
    if (!profile || typeof profile !== "object") return false;

    const accountStatus = String(profile.status || "active").trim().toLowerCase();
    return (
        !["inactive", "disabled", "suspended", "trashed"].includes(accountStatus) &&
        profile.active !== false
    );
}

function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
}

function readSavedSession() {
    try {
        const parsed = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
        if (!parsed || typeof parsed.id !== "string") return null;
        return parsed;
    } catch {
        sessionStorage.removeItem(SESSION_KEY);
        return null;
    }
}

function saveSession(session) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession() {
    sessionStorage.removeItem(SESSION_KEY);

    state.session = null;
}

function showLoading(message = "Processing request…") {
    const overlay = $("global-loading");
    if (!overlay) return;
    const label = $("loading-text");
    if (label) label.textContent = message;
    overlay.classList.remove("hidden");
    overlay.classList.add("flex");
}

function hideLoading() {
    const overlay = $("global-loading");
    if (!overlay) return;
    overlay.classList.add("hidden");
    overlay.classList.remove("flex");
}

function openModal(id) {
    const modal = $(id);
    if (!modal) return;
    modal.classList.remove("hidden");
    modal.classList.add("flex");
}

function closeModal(id) {
    const modal = $(id);
    if (!modal) return;
    modal.classList.add("hidden");
    modal.classList.remove("flex");
}

function showAlert(title, message, success = false) {
    const icon = $("organizer-alert-icon");
    $("organizer-alert-title").textContent = title;
    $("organizer-alert-msg").textContent = message;
    icon.className = success
        ? "w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4 text-xl bg-emerald-50 text-emerald-600"
        : "w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4 text-xl bg-rose-50 text-rose-600";
    icon.innerHTML = success
        ? '<i class="fa-solid fa-circle-check"></i>'
        : '<i class="fa-solid fa-circle-exclamation"></i>';
    openModal("organizer-alert-modal");
}

function showConfirm(title, message, proceedLabel = "Proceed") {
    if (confirmResolver) {
        confirmResolver(false);
        confirmResolver = null;
    }
    $("confirm-title").textContent = title;
    $("confirm-msg").textContent = message;
    $("confirm-proceed-btn").textContent = proceedLabel;
    openModal("confirm-modal");
    return new Promise((resolve) => {
        confirmResolver = resolve;
    });
}

function resolveConfirm(result) {
    closeModal("confirm-modal");
    const resolver = confirmResolver;
    confirmResolver = null;
    if (resolver) resolver(result);
}

function statusBadge(status, labelOverride = "") {
    const value = String(status || STATUS.PENDING);
    const normalized = value.toLowerCase();
    let css = "badge-neutral";
    if (["approved", "confirmed", "completed", "verified"].includes(normalized))
        css = "badge-success";
    else if (["rejected", "cancelled", "canceled"].includes(normalized))
        css = "badge-danger";
    else if (["pending", "awaiting"].includes(normalized)) css = "badge-warning";
    else if (["registered", "submitted"].includes(normalized)) css = "badge-info";
    return `<span class="${css} inline-flex px-2.5 py-1 rounded-full text-[11px] font-bold">${escapeHtml(labelOverride || value)}</span>`;
}

function emptyTableRow(columns, message, icon = "fa-inbox") {
    return `<tr><td colspan="${columns}" class="px-6 py-12 text-center text-slate-400"><i class="fa-solid ${icon} text-2xl mb-3 block text-slate-300"></i><span class="text-sm">${escapeHtml(message)}</span></td></tr>`;
}

function collectionErrorMarkup(message) {
    return `<div class="bg-rose-50 border border-rose-200 text-rose-700 rounded-2xl p-6 text-sm"><i class="fa-solid fa-triangle-exclamation mr-2"></i>${escapeHtml(message)}</div>`;
}

function requireOrganizerSession() {
    if (!state.session?.id || state.session.role !== "organizer") {
        throw new Error(
            "Your organizer session has expired. Please sign in again.",
        );
    }
}

async function createNotification(
    residentId,
    title,
    message,
    type = "general",
) {
    if (!residentId) return;
    try {
        await addDoc(collection(db, "notifications"), {
            residentId,
            title,
            message,
            type,
            read: false,
            createdAt: serverTimestamp(),
        });
    } catch (error) {
        // Notification delivery should not undo a completed organizer action.
        console.error("Notification could not be created:", error);
    }
}

function setAccountLabels() {
    const name = getDisplayName();
    const sidebarName = $("sidebar-user-name");
    const sidebarEmail = $("sidebar-user-email");
    const headerName = $("header-user-name");
    if (sidebarName) sidebarName.textContent = name;
    if (sidebarEmail) sidebarEmail.textContent = state.session?.email || "";
    if (headerName) headerName.textContent = name;
}

function showLoginScreen() {
    $("dashboard").classList.add("hidden");
    $("dashboard").classList.remove("flex");
    $("login-screen").classList.remove("hidden");
    $("login-screen").classList.add("flex");
}

function showDashboard() {
    $("login-screen").classList.add("hidden");
    $("login-screen").classList.remove("flex");
    $("dashboard").classList.remove("hidden");
    $("dashboard").classList.add("flex");
    setAccountLabels();
}

function switchTab(tabName) {
    const requested = ALLOWED_TABS.includes(tabName) ? tabName : "announcements";
    state.activeTab = requested;
    localStorage.setItem(TAB_KEY, requested);

    document
        .querySelectorAll(".tab-content")
        .forEach((section) => section.classList.add("hidden"));
    $(requested)?.classList.remove("hidden");

    document.querySelectorAll("[data-tab]").forEach((button) => {
        button.classList.toggle("active", button.dataset.tab === requested);
        button.setAttribute(
            "aria-current",
            button.dataset.tab === requested ? "page" : "false",
        );
    });
    $("page-title").textContent = TAB_TITLES[requested];
}

function stopPortalListeners() {
    state.unsubscribers.forEach((unsubscribe) => {
        try {
            unsubscribe();
        } catch (error) {
            console.warn("Listener cleanup failed:", error);
        }
    });
    state.unsubscribers = [];
}

function subscribeToCollection(name, onData, onError) {
    const unsubscribe = onSnapshot(
        collection(db, name),
        (snapshot) =>
            onData(
                snapshot.docs.map((snapshotDoc) => ({
                    id: snapshotDoc.id,
                    ...snapshotDoc.data(),
                })),
            ),
        (error) => {
            console.error(`Unable to load ${name}:`, error);
            onError(error);
        },
    );
    state.unsubscribers.push(unsubscribe);
}

function startPortalListeners() {
    stopPortalListeners();

    // Show loading placeholders in every tab while the first data snapshots arrive.
    renderPortalLoading();

    // Keep the organizer profile active while the console is open.
    const sessionProfileUnsubscribe = onSnapshot(
        doc(db, "organizers", state.session.id),
        (snapshot) => {
            if (snapshot.exists() && isActiveOrganizer(snapshot.data())) return;
            stopPortalListeners();
            clearSession();
            showLoginScreen();
            showAlert(
                "Access revoked",
                "This organizer account is no longer active. Please contact an administrator.",
            );
        },
        (error) => console.error("Organizer profile monitoring failed:", error),
    );
    state.unsubscribers.push(sessionProfileUnsubscribe);

    subscribeToCollection(
        "announcements",
        (records) => {
            state.announcements = records.sort(
                (a, b) =>
                    timestampToMillis(b.createdAt) - timestampToMillis(a.createdAt),
            );
            renderAnnouncements();
        },
        () => {
            $("announcements-container").innerHTML = collectionErrorMarkup(
                "Announcements could not be loaded. Check Firestore access rules.",
            );
        },
    );

    subscribeToCollection(
        "events",
        (records) => {
            state.events = records
                .filter(
                    (record) =>
                        String(record.status || "").toLowerCase() !==
                        STATUS.TRASHED.toLowerCase(),
                )
                .sort((a, b) =>
                    String(a.date || "9999-12-31").localeCompare(
                        String(b.date || "9999-12-31"),
                    ),
                );
            renderEvents();
        },
        () => {
            $("events-grid").innerHTML =
                `<div class="col-span-full">${collectionErrorMarkup("Events could not be loaded. Check Firestore access rules.")}</div>`;
        },
    );

    subscribeToCollection(
        "volunteers",
        (records) => {
            state.volunteers = records.filter(
                (record) =>
                    String(record.status || "").toLowerCase() !==
                    STATUS.TRASHED.toLowerCase(),
            );
            renderVolunteers();
        },
        () => {
            $("organizer-volunteers-tbody").innerHTML = emptyTableRow(
                7,
                "Volunteer data could not be loaded.",
                "fa-triangle-exclamation",
            );
        },
    );

    subscribeToCollection(
        "donations",
        (records) => {
            state.donations = records.filter(
                (record) =>
                    String(record.status || "").toLowerCase() !==
                    STATUS.TRASHED.toLowerCase(),
            );
            renderDonations();
        },
        () => {
            $("organizer-donations-tbody").innerHTML = emptyTableRow(
                6,
                "Donation data could not be loaded.",
                "fa-triangle-exclamation",
            );
        },
    );

    subscribeToCollection(
        "participants",
        (records) => {
            state.participants = records.filter(
                (record) =>
                    String(record.status || "").toLowerCase() !==
                    STATUS.TRASHED.toLowerCase(),
            );
            renderParticipantSelect();
            renderActivityLogs();
        },
        () => {
            $("hour-participant-select").innerHTML =
                '<option value="">Participant data unavailable</option>';
            $("activity-logs-tbody").innerHTML = emptyTableRow(
                5,
                "Registration activity could not be loaded.",
                "fa-triangle-exclamation",
            );
        },
    );

    subscribeToCollection(
        "service_hours",
        (records) => {
            state.serviceHours = records.sort(
                (a, b) =>
                    timestampToMillis(b.certifiedAt) - timestampToMillis(a.certifiedAt),
            );
            renderServiceHours();
        },
        () => {
            $("organizer-hours-tbody").innerHTML = emptyTableRow(
                5,
                "Service-hour records could not be loaded.",
                "fa-triangle-exclamation",
            );
        },
    );
}

function renderAnnouncementsLoading() {
    const container = $("announcements-container");
    if (!container) return;
    const skeletonCard = `<div class="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm animate-pulse">
      <div class="flex items-start justify-between gap-3">
        <div class="w-9 h-9 rounded-lg bg-slate-200"></div>
        <div class="flex items-center gap-1.5">
          <div class="w-7 h-7 rounded-lg bg-slate-100"></div>
          <div class="w-7 h-7 rounded-lg bg-slate-100"></div>
        </div>
      </div>
      <div class="flex items-center gap-2 mt-3">
        <div class="h-4 w-16 rounded-full bg-slate-200"></div>
        <div class="h-3 w-24 rounded bg-slate-100"></div>
      </div>
      <div class="h-4 w-3/4 rounded bg-slate-200 mt-3"></div>
      <div class="mt-2 rounded-lg bg-slate-100 aspect-video"></div>
      <div class="space-y-2 mt-3">
        <div class="h-3 w-full rounded bg-slate-100"></div>
        <div class="h-3 w-5/6 rounded bg-slate-100"></div>
        <div class="h-3 w-2/3 rounded bg-slate-100"></div>
      </div>
      <div class="h-3 w-28 rounded bg-slate-100 mt-3 pt-0"></div>
    </div>`;
    container.innerHTML = skeletonCard.repeat(3);
}

function renderEventsLoading() {
    const grid = $("events-grid");
    if (!grid) return;
    const skeletonCard = `<div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden min-h-[330px] flex flex-col animate-pulse">
      <div class="h-40 bg-slate-200"></div>
      <div class="p-5 flex flex-col flex-1">
        <div class="h-4 w-16 rounded-md bg-slate-200 mb-2"></div>
        <div class="h-4 w-4/5 rounded bg-slate-200"></div>
        <div class="space-y-2 mt-3">
          <div class="h-3 w-2/3 rounded bg-slate-100"></div>
          <div class="h-3 w-1/2 rounded bg-slate-100"></div>
          <div class="h-3 w-2/5 rounded bg-slate-100"></div>
        </div>
        <div class="flex gap-2 mt-auto pt-5">
          <div class="flex-1 h-8 rounded-lg bg-slate-100"></div>
          <div class="w-9 h-8 rounded-lg bg-slate-100"></div>
          <div class="w-9 h-8 rounded-lg bg-slate-100"></div>
        </div>
      </div>
    </div>`;
    grid.innerHTML = skeletonCard.repeat(4);
}

function skeletonTableRows(columnCount, rowCount = 5) {
    const widths = ["w-3/4", "w-2/3", "w-1/2", "w-4/5", "w-3/5"];
    let rows = "";
    for (let r = 0; r < rowCount; r += 1) {
        let cells = "";
        for (let c = 0; c < columnCount; c += 1) {
            cells += `<td class="px-4 py-4"><div class="h-3 ${widths[(r + c) % widths.length]} rounded bg-slate-200 animate-pulse"></div></td>`;
        }
        rows += `<tr>${cells}</tr>`;
    }
    return rows;
}

function renderTableLoading(tbodyId, columnCount, rowCount = 5) {
    const tbody = $(tbodyId);
    if (!tbody) return;
    tbody.innerHTML = skeletonTableRows(columnCount, rowCount);
}

function renderPortalLoading() {
    renderAnnouncementsLoading();
    renderEventsLoading();
    renderTableLoading("organizer-volunteers-tbody", 6, 6);
    renderTableLoading("organizer-hours-tbody", 5, 4);
    renderTableLoading("activity-logs-tbody", 5, 5);
    renderTableLoading("organizer-donations-tbody", 6, 6);
}

function renderAnnouncements() {
    const container = $("announcements-container");
    if (!state.announcements.length) {
        container.innerHTML =
            '<div class="col-span-full bg-white border border-dashed border-slate-300 rounded-2xl p-12 text-center text-slate-400"><i class="fa-solid fa-bullhorn text-3xl text-slate-300"></i><p class="font-semibold mt-3">No announcements yet</p><p class="text-xs mt-1">Dispatch the first public update from this console.</p></div>';
        return;
    }

    container.innerHTML = state.announcements
        .map((announcement) => {
            const priority = String(announcement.priority || "Normal");
            const normalized = priority.toLowerCase();
            const theme =
                normalized === "emergency"
                    ? {
                        wrap: "border-rose-200 bg-rose-50/40",
                        icon: "bg-rose-100 text-rose-700",
                        badge: "badge-danger",
                        glyph: "fa-triangle-exclamation",
                    }
                    : normalized === "important"
                        ? {
                            wrap: "border-amber-200 bg-amber-50/40",
                            icon: "bg-amber-100 text-amber-700",
                            badge: "badge-warning",
                            glyph: "fa-circle-exclamation",
                        }
                        : {
                            wrap: "border-slate-200 bg-white",
                            icon: "bg-victoria-light text-victoria-blue",
                            badge: "badge-info",
                            glyph: "fa-bullhorn",
                        };
            const imageUrl = safeImageUrl(
                announcement.imageUrl || announcement.image,
            );

            return `<article class="${theme.wrap} border rounded-2xl p-4 shadow-sm card flex flex-col h-full">
      <div class="flex items-start justify-between gap-3">
        <div class="${theme.icon} w-9 h-9 rounded-lg flex items-center justify-center shrink-0"><i class="fa-solid ${theme.glyph} text-sm"></i></div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button type="button" data-action="edit-announcement" data-id="${escapeHtml(announcement.id)}" class="w-7 h-7 rounded-lg text-amber-700 bg-amber-50 hover:bg-amber-600 hover:text-white transition-colors" aria-label="Edit announcement" title="Edit announcement"><i class="fa-solid fa-pen text-xs"></i></button>
          <button type="button" data-action="delete-announcement" data-id="${escapeHtml(announcement.id)}" class="w-7 h-7 rounded-lg text-rose-500 bg-rose-50 hover:bg-rose-600 hover:text-white transition-colors" aria-label="Delete announcement" title="Delete announcement"><i class="fa-solid fa-trash text-xs"></i></button>
        </div>
      </div>
      <div class="flex items-center flex-wrap gap-2 mt-2">
        <span class="${theme.badge} px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider">${escapeHtml(priority)}</span>
        <span class="text-[11px] text-slate-400"><i class="fa-regular fa-clock mr-1"></i>${escapeHtml(formatTimestamp(announcement.createdAt))}</span>
      </div>
      <h3 class="font-extrabold text-slate-900 text-sm mt-1.5 break-words line-clamp-2">${escapeHtml(announcement.title || "Untitled announcement")}</h3>
      ${imageUrl ? `<div class="mt-2 rounded-lg overflow-hidden border border-slate-200 bg-slate-100 aspect-video"><img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(announcement.title || "Announcement image")}" class="w-full h-full object-cover" loading="lazy" decoding="async"></div>` : ""}
      <p class="text-xs text-slate-600 mt-2 leading-relaxed break-words line-clamp-3 flex-1">${escapeHtml(announcement.desc || announcement.description || "")}</p>
      <p class="text-[11px] text-slate-400 mt-2 pt-2 border-t border-slate-200/70">Posted by ${escapeHtml(announcement.createdBy || "Organizer")}</p>
    </article>`;
        })
        .join("");
}

function renderEvents() {
    const grid = $("events-grid");
    if (!state.events.length) {
        grid.innerHTML =
            '<div class="col-span-full bg-white border border-dashed border-slate-300 rounded-2xl p-12 text-center text-slate-400"><i class="fa-solid fa-calendar-plus text-3xl text-slate-300"></i><p class="font-semibold mt-3">No events scheduled</p><p class="text-xs mt-1">Use “Schedule event” to add an activity.</p></div>';
        return;
    }

    grid.innerHTML = state.events
        .map((eventRecord) => {
            const imageUrl = safeImageUrl(eventRecord.imageUrl);
            const title = eventRecord.title || "Untitled event";
            const dateText = formatEventDate(eventRecord.date);
            const timeText = formatTime(eventRecord.time);
            return `<article class="bg-white rounded-2xl border border-slate-200 shadow-sm flex flex-col card overflow-hidden min-h-[330px]">
      ${imageUrl
                    ? `<div class="h-40 bg-slate-100 overflow-hidden"><img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(title)}" class="w-full h-full object-cover" loading="lazy"></div>`
                    : '<div class="h-32 bg-gradient-to-br from-victoria-dark via-victoria-blue to-victoria-accent flex items-center justify-center bg-pattern"><i class="fa-solid fa-calendar-day text-4xl text-white/70"></i></div>'
                }
      <div class="p-5 flex flex-col flex-1">
        <span class="text-[10px] font-bold uppercase bg-victoria-light text-victoria-blue px-2.5 py-1 rounded-md mb-2 inline-block w-fit">${escapeHtml(eventRecord.type || eventRecord.category || "Event")}</span>
        <h3 class="font-extrabold text-slate-900 leading-snug">${escapeHtml(title)}</h3>
        <div class="space-y-1.5 mt-3 text-xs text-slate-500">
          <p><i class="fa-solid fa-calendar w-4 text-victoria-accent"></i>${escapeHtml(dateText)}${timeText ? ` · ${escapeHtml(timeText)}` : ""}</p>
          <p><i class="fa-solid fa-location-dot w-4 text-victoria-accent"></i>${escapeHtml(eventRecord.location || "Location TBA")}</p>
          <p class="text-slate-400"><i class="fa-solid fa-user-pen w-4"></i>${escapeHtml(eventRecord.createdBy || "Organizer")}</p>
        </div>
        <div class="flex gap-2 mt-auto pt-5">
          <button type="button" data-action="view-event" data-id="${escapeHtml(eventRecord.id)}" class="flex-1 text-xs border border-slate-300 text-slate-700 font-bold py-2 rounded-lg hover:bg-slate-50"><i class="fa-solid fa-eye mr-1"></i>View</button>
          <button type="button" data-action="edit-event" data-id="${escapeHtml(eventRecord.id)}" class="w-9 text-xs bg-amber-50 text-amber-700 rounded-lg hover:bg-amber-600 hover:text-white" aria-label="Edit event"><i class="fa-solid fa-pen"></i></button>
          <button type="button" data-action="delete-event" data-id="${escapeHtml(eventRecord.id)}" class="w-9 text-xs bg-rose-50 text-rose-600 rounded-lg hover:bg-rose-600 hover:text-white" aria-label="Delete event"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>
    </article>`;
        })
        .join("");
}

function renderVolunteers() {
    const filter = $("volunteer-filter")?.value || "all";
    const sort = $("volunteer-sort")?.value || "date-desc";
    // REJECTION BUG FIX: normalized status comparison in the filter.
    let records = state.volunteers.filter(
        (volunteer) =>
            filter === "all" ||
            effectiveStatus(volunteer) === normalizeStatus(filter),
    );

    records.sort((a, b) => {
        if (sort === "name-asc" || sort === "name-desc") {
            const result = String(a.name || "").localeCompare(
                String(b.name || ""),
                undefined,
                { sensitivity: "base" },
            );
            return sort === "name-asc" ? result : -result;
        }
        const result =
            timestampToMillis(a.createdAt) - timestampToMillis(b.createdAt);
        return sort === "date-asc" ? result : -result;
    });

    $("volunteer-result-count").textContent =
        `${records.length} ${records.length === 1 ? "record" : "records"}`;
    const tbody = $("organizer-volunteers-tbody");
    if (!records.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="px-4 py-6 text-center text-stone-400">No volunteer applications ${filter === "all" ? "yet." : "match this view."}</td></tr>`;
        refreshActionBadges();
        return;
    }

    tbody.innerHTML = records
        .map((volunteer) => {
            const id = volunteer.id;
            // REJECTION BUG FIX: normalized status comparison.
            const status = effectiveStatus(volunteer);
            let sb = "";
            if (status === STATUS.APPROVED)
                sb =
                    '<span class="badge-success px-2 py-0.5 rounded text-xs font-bold">Approved</span>';
            else if (status === STATUS.REJECTED)
                sb =
                    '<span class="badge-danger px-2 py-0.5 rounded text-xs font-bold">Rejected</span>';
            else
                sb =
                    '<span class="badge-warning px-2 py-0.5 rounded text-xs font-bold">Pending</span>';

            const skillsDisplay = escapeHtml(volunteer.skills || "N/A");
            const experienceDisplay = volunteer.experience
                ? `<span class="text-xs text-stone-500 block mt-1">Experience: ${escapeHtml(volunteer.experience)}</span>`
                : "";

            // Document display
            let docDisplay =
                '<span class="text-xs text-stone-400">No document</span>';
            const verification = volunteer.verificationFile;
            if (verification?.data) {
                const fn = verification.fileName || "Document";
                const truncatedName = fn.length > 20 ? fn.substring(0, 17) + "..." : fn;
                const fe = fn.split(".").pop().toLowerCase();
                let fileIcon = "fa-file";
                if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(fe))
                    fileIcon = "fa-file-image";
                else if (fe === "pdf") fileIcon = "fa-file-pdf";
                else if (["doc", "docx"].includes(fe)) fileIcon = "fa-file-word";
                else if (["xls", "xlsx"].includes(fe)) fileIcon = "fa-file-excel";
                else if (["ppt", "pptx"].includes(fe)) fileIcon = "fa-file-powerpoint";
                else if (["zip", "rar"].includes(fe)) fileIcon = "fa-file-zipper";
                else fileIcon = "fa-file-lines";
                docDisplay = `
      <div class="flex items-center gap-1.5" title="${escapeHtml(fn)}">
        <div class="flex items-center gap-1.5 cursor-pointer hover:opacity-80 transition-opacity"
             onclick="event.stopPropagation();window.viewVerificationFile('${escapeHtml(id)}')"
             title="Click to preview: ${escapeHtml(fn)}">
          <i class="fa-solid ${fileIcon} text-victoria-blue text-sm shrink-0"></i>
          <span class="text-xs text-victoria-blue font-medium truncate max-w-[105px] hover:underline">${escapeHtml(truncatedName)}</span>
        </div>
        <button type="button"
                onclick="event.stopPropagation();window.downloadVerificationFile('${escapeHtml(id)}')"
                class="w-7 h-7 rounded-lg bg-emerald-50 text-emerald-600 hover:bg-emerald-600 hover:text-white transition-all flex items-center justify-center shrink-0"
                title="Download: ${escapeHtml(fn)}">
          <i class="fa-solid fa-download text-xs"></i>
        </button>
      </div>`;
            }

            // Contact display - email only, truncated
            const email = volunteer.email || "N/A";
            const truncatedEmail =
                email.length > 18 ? email.substring(0, 15) + "..." : email;
            const contactDisplay = `
  <div class="text-xs text-stone-600 w-[160px]" title="${escapeHtml(email)}">
    <i class="fa-solid fa-envelope mr-1 text-stone-400 shrink-0"></i>
    <span class="truncate inline-block max-w-[130px] align-middle">${escapeHtml(truncatedEmail)}</span>
  </div>`;

            const notesDisplay = volunteer.notes
                ? `<div class="mt-1"><button type="button" onclick="event.stopPropagation();window.showVolunteerNotes('${escapeHtml(id)}')" class="text-xs bg-amber-50 text-amber-600 px-2 py-1 rounded hover:bg-amber-600 hover:text-white"><i class="fa-solid fa-note-sticky mr-1"></i>Notes</button></div>`
                : "";

            const isNew = status === STATUS.PENDING;
            return `<tr class="${isNew ? "row-new " : ""}hover:bg-blue-50/60 cursor-pointer border-b table-row volunteer-row transition-colors" data-status="${escapeHtml(status)}" onclick="openVolunteerDetailsModal('${escapeHtml(id)}')"><td class="px-4 py-3"><div class="font-bold text-stone-900">${escapeHtml(volunteer.name || volunteer.fullName || "N/A")}${isNew ? " " + newChipHtml() : ""}</div>${notesDisplay}</td><td class="px-4 py-3">${contactDisplay}</td><td class="px-4 py-3"><div class="text-sm font-semibold text-stone-800">${skillsDisplay}</div>${experienceDisplay}</td><td class="px-4 py-3 text-sm text-stone-600">${escapeHtml(volunteer.availability || "N/A")}</td><td class="px-4 py-3" onclick="event.stopPropagation()">${docDisplay}</td><td class="px-4 py-3">${sb}</td></tr>`;
        })
        .join("");
    refreshActionBadges();
}

function formatDonationResource(donation) {
    if (
        donation.amount !== undefined &&
        donation.amount !== null &&
        donation.amount !== ""
    ) {
        const number = Number(donation.amount);
        if (Number.isFinite(number))
            return `₱${number.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        return `₱${donation.amount}`;
    }
    // CATEGORIZED ITEMS (mirrored from Resident Hub): item donations now carry
    // itemDescription + itemCategory + itemQuantity(+unit). This also fixes
    // item donations previously showing "Not specified" because the organizer
    // only looked at the legacy `item` field.
    const description =
        donation.itemDescription ||
        donation.item ||
        donation.resource ||
        "Not specified";
    const details = [];
    if (donation.itemCategory) details.push(String(donation.itemCategory));
    const qty = Number(donation.itemQuantity || 0);
    if (Number.isFinite(qty) && qty > 0) {
        const unit = String(donation.itemUnit || "").trim();
        details.push(`Qty: ${qty}${unit ? " " + unit : ""}`);
    }
    const value = Number(donation.itemValue || 0);
    if (Number.isFinite(value) && value > 0)
        details.push(`₱${value.toLocaleString()} est. value`);
    return details.length ? `${description} (${details.join(" • ")})` : description;
}

function renderDonations() {
    const filter = $("donation-filter")?.value || "all";
    const sort = $("donation-sort")?.value || "date-desc";
    let records = state.donations.filter((donation) => {
        if (filter === "all") return true;
        // REJECTION BUG FIX: normalized status comparison (legacy lowercase or
        // "Confirmed" records now land in the right filter bucket).
        const status = effectiveStatus(donation);
        return filter === STATUS.APPROVED || filter === STATUS.CONFIRMED
            ? status === STATUS.APPROVED
            : status === normalizeStatus(filter);
    });

    records.sort((a, b) => {
        if (sort === "name-asc" || sort === "name-desc") {
            const result = String(a.donorName || "").localeCompare(
                String(b.donorName || ""),
                undefined,
                { sensitivity: "base" },
            );
            return sort === "name-asc" ? result : -result;
        }
        const result =
            timestampToMillis(a.createdAt) - timestampToMillis(b.createdAt);
        return sort === "date-asc" ? result : -result;
    });

    $("donation-result-count").textContent =
        `${records.length} ${records.length === 1 ? "record" : "records"}`;
    const tbody = $("organizer-donations-tbody");
    if (!records.length) {
        tbody.innerHTML = emptyTableRow(
            6,
            "No donation records match this view.",
            "fa-hand-holding-heart",
        );
        refreshActionBadges();
        return;
    }

    tbody.innerHTML = records
        .map((donation) => {
            // REJECTION BUG FIX: normalized status drives labels and actions.
            const status = effectiveStatus(donation);
            const statusLabel = status === STATUS.APPROVED ? "Confirmed" : status;
            let actions = "";
            if (status !== STATUS.APPROVED) {
                actions += `<button type="button" data-action="donation-status" data-id="${escapeHtml(donation.id)}" data-status="${STATUS.APPROVED}" class="text-xs bg-emerald-50 text-emerald-700 px-2.5 py-1.5 rounded-lg hover:bg-emerald-600 hover:text-white"><i class="fa-solid fa-check mr-1"></i>Confirm</button>`;
            }
            if (status !== STATUS.REJECTED) {
                actions += `<button type="button" data-action="donation-status" data-id="${escapeHtml(donation.id)}" data-status="${STATUS.REJECTED}" class="text-xs bg-rose-50 text-rose-700 px-2.5 py-1.5 rounded-lg hover:bg-rose-600 hover:text-white"><i class="fa-solid fa-xmark mr-1"></i>Reject</button>`;
            }
            if (status !== STATUS.PENDING) {
                actions += `<button type="button" data-action="donation-status" data-id="${escapeHtml(donation.id)}" data-status="${STATUS.PENDING}" class="text-xs bg-amber-50 text-amber-700 px-2.5 py-1.5 rounded-lg hover:bg-amber-600 hover:text-white"><i class="fa-solid fa-rotate mr-1"></i>Reset</button>`;
            }

            const screenshotUrl = safeImageUrl(
                donation.paymentScreenshot ||
                donation.screenshot ||
                donation.proofOfPayment ||
                "",
            );
            const methodText = formatPaymentMethodName(
                donation.paymentMethod ||
                (screenshotUrl ? "E-Wallet / Bank" : "Cash / Item"),
            );
            let proofCell = "";
            if (screenshotUrl) {
                proofCell = `<div class="flex items-center gap-2.5">
          <div class="w-11 h-11 rounded-xl overflow-hidden border border-slate-200 bg-slate-100 shrink-0 cursor-pointer shadow-sm hover:ring-2 hover:ring-victoria-blue transition-all" onclick="openDonationScreenshotModal('${escapeHtml(donation.id)}')">
            <img src="${escapeHtml(screenshotUrl)}" alt="Receipt" loading="lazy" decoding="async" class="w-full h-full object-cover">
          </div>
          <div>
            <button type="button" onclick="openDonationScreenshotModal('${escapeHtml(donation.id)}')" class="text-xs font-bold text-victoria-blue hover:underline flex items-center gap-1">
              <i class="fa-solid fa-file-invoice-dollar text-victoria-gold"></i> View Receipt
            </button>
            <p class="text-[10px] text-slate-500 font-medium uppercase tracking-wide mt-0.5">${escapeHtml(methodText)}</p>
          </div>
        </div>`;
            } else {
                const isCash =
                    String(donation.paymentMethod || "").toLowerCase() === "cash" ||
                    String(donation.paymentMethod || "").toLowerCase() === "cash payment";
                proofCell = `<span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium ${isCash ? "bg-amber-50 text-amber-800 border border-amber-200" : "bg-slate-100 text-slate-600 border border-slate-200"}">
          <i class="fa-solid ${isCash ? "fa-money-bill-wave text-amber-600" : "fa-box text-slate-400"}"></i> ${escapeHtml(methodText)}
        </span>`;
            }

            const isNew = status === STATUS.PENDING;
            return `<tr class="${isNew ? "row-new " : ""}hover:bg-blue-50/60 cursor-pointer align-top transition-colors" onclick="openDonationScreenshotModal('${escapeHtml(donation.id)}')">
      <td class="px-5 py-4 min-w-40"><p class="font-bold text-slate-900">${escapeHtml(donation.donorName || "Anonymous")}${isNew ? " " + newChipHtml() : ""}</p>${donation.paymentMethod ? `<p class="text-[11px] text-slate-400 mt-0.5">${escapeHtml(donation.paymentMethod)}</p>` : ""}${donation.userReferenceNumber ? `<p class="text-[10px] font-mono font-bold text-victoria-blue mt-0.5" title="Reference number submitted by the donor"><i class="fa-solid fa-hashtag mr-0.5"></i>Ref: ${escapeHtml(donation.userReferenceNumber)}</p>` : ""}</td>
      <td class="px-4 py-4 min-w-36 font-bold text-emerald-800">${escapeHtml(formatDonationResource(donation))}</td>
      <td class="px-4 py-4 min-w-48" onclick="event.stopPropagation(); openDonationScreenshotModal('${escapeHtml(donation.id)}');">${proofCell}</td>
      <td class="px-4 py-4 min-w-48 text-sm text-slate-600">${escapeHtml(donation.purpose || "Not specified")}</td>
      <td class="px-4 py-4 min-w-36 text-xs text-slate-500">${escapeHtml(formatTimestamp(donation.createdAt))}</td>
      <td class="px-4 py-4">${statusBadge(status, statusLabel)}</td>
    </tr>`;
        })
        .join("");
    refreshActionBadges();
}

function renderParticipantSelect() {
    const select = $("hour-participant-select");
    const eligible = state.participants
        .filter(
            (participant) =>
                String(participant.status || STATUS.REGISTERED) === STATUS.REGISTERED,
        )
        .sort((a, b) =>
            String(a.residentName || "").localeCompare(String(b.residentName || "")),
        );

    if (!eligible.length) {
        select.innerHTML =
            '<option value="">No active registrations found</option>';
        return;
    }

    select.innerHTML =
        '<option value="">Select a participant</option>' +
        eligible
            .map(
                (participant) =>
                    `<option value="${escapeHtml(participant.id)}">${escapeHtml(participant.residentName || "Unnamed resident")} — ${escapeHtml(participant.eventTitle || "Untitled event")}</option>`,
            )
            .join("");
}

function renderServiceHours() {
    const tbody = $("organizer-hours-tbody");
    if (!state.serviceHours.length) {
        tbody.innerHTML = emptyTableRow(
            5,
            "No service hours have been certified yet.",
            "fa-clock",
        );
        return;
    }

    tbody.innerHTML = state.serviceHours
        .map(
            (
                record,
            ) => `<tr class="hover:bg-blue-50/60 cursor-pointer transition-colors" onclick="openServiceHourDetailsModal('${escapeHtml(record.id)}')">
    <td class="px-4 py-3 font-semibold text-slate-800 min-w-36">${escapeHtml(record.residentName || "Unknown resident")}</td>
    <td class="px-4 py-3 text-slate-600 min-w-40">${escapeHtml(record.eventTitle || "Unknown event")}</td>
    <td class="px-4 py-3 text-center"><span class="font-extrabold text-victoria-blue">${escapeHtml(record.hours || 0)}</span> <span class="text-xs text-slate-400">hrs</span></td>
    <td class="px-4 py-3">${statusBadge(record.status || STATUS.APPROVED)}</td>
    <td class="px-4 py-3 min-w-36"><p class="text-xs font-semibold text-slate-600">${escapeHtml(record.certifiedBy || "Organizer")}</p><p class="text-[10px] text-slate-400 mt-0.5">${escapeHtml(formatTimestamp(record.certifiedAt))}</p></td>
  </tr>`,
        )
        .join("");
}

function participantActivityLabel(participant) {
    const status = String(participant.status || STATUS.REGISTERED);
    if (status === STATUS.COMPLETED) return "Service hours credited";
    if (status === STATUS.CANCELLED) return "Registration cancelled";
    if (status === STATUS.REJECTED) return "Registration rejected";
    return "Event registration";
}

function participantTimestamp(participant) {
    return (
        participant.completedAt ||
        participant.cancelledAt ||
        participant.rejectedAt ||
        participant.timestamp ||
        participant.createdAt
    );
}

function renderActivityLogs() {
    const filter = state.activityFilter;
    let records = [...state.participants]
        .filter(
            (participant) =>
                filter === "all" ||
                String(participant.status || STATUS.REGISTERED) === filter,
        )
        .sort(
            (a, b) =>
                timestampToMillis(participantTimestamp(b)) -
                timestampToMillis(participantTimestamp(a)),
        );

    $("activity-result-count").textContent =
        `${records.length} ${records.length === 1 ? "activity" : "activities"}`;
    const tbody = $("activity-logs-tbody");
    if (!records.length) {
        tbody.innerHTML = emptyTableRow(
            5,
            "No registration activity matches this view.",
            "fa-clock-rotate-left",
        );
        refreshActionBadges();
        return;
    }

    tbody.innerHTML = records
        .map((participant) => {
            const status = participant.status || STATUS.REGISTERED;
            const statusLabel = status === STATUS.COMPLETED ? "Credited" : status;
            const isNew = status === STATUS.REGISTERED;
            return `<tr class="${isNew ? "row-new " : ""}hover:bg-slate-50">
      <td class="px-5 py-3 font-semibold text-slate-800 min-w-40">${escapeHtml(participant.residentName || "Unknown resident")}${isNew ? " " + newChipHtml() : ""}</td>
      <td class="px-4 py-3 text-slate-600 min-w-44">${escapeHtml(participant.eventTitle || "Unknown event")}</td>
      <td class="px-4 py-3 text-xs text-slate-500 min-w-40">${escapeHtml(participantActivityLabel(participant))}</td>
      <td class="px-4 py-3 text-xs text-slate-500 min-w-36">${escapeHtml(formatTimestamp(participantTimestamp(participant)))}</td>
      <td class="px-4 py-3">${statusBadge(status, statusLabel)}</td>
    </tr>`;
        })
        .join("");
    refreshActionBadges();
}

async function handleLogin(event) {
    event.preventDefault();
    const email = normalizeEmail($("login-email").value);
    const password = $("login-password").value;
    if (!email || !password) {
        showAlert(
            "Missing credentials",
            "Enter your organizer email and password.",
        );
        return;
    }

    showLoading();
    try {
        // Only documents in Firestore's `organizers` collection can open this
        // console. The email and password must both match the values stored in the
        // same organizer document. A `role` field is intentionally not required.
        const snapshot = await getDocs(
            query(
                collection(db, "organizers"),
                where("email", "==", email),
                limit(10),
            ),
        );
        const match = snapshot.docs.find((candidate) => {
            const profile = candidate.data();
            return (
                normalizeEmail(profile.email) === email &&
                String(profile.password ?? "") === password &&
                isActiveOrganizer(profile)
            );
        });

        if (!match) {
            showAlert(
                "Access denied",
                "The email or password does not match an active organizer account in Firestore.",
            );
            return;
        }

        const profile = match.data();
        state.session = {
            id: match.id,
            email: normalizeEmail(profile.email) || email,
            name: profile.name || profile.displayName || email.split("@")[0],
            role: "organizer",
        };
        saveSession(state.session);
        showDashboard();
        startPortalListeners();
        switchTab("announcements");
        $("login-form").reset();
        showAlert(
            "Welcome",
            `Organizer access granted to ${getDisplayName()}.`,
            true,
        );
    } catch (error) {
        console.error("Organizer login failed:", error);
        showAlert(
            "Unable to sign in",
            error.message || "The organizer account could not be verified.",
        );
    } finally {
        hideLoading();
    }
}

async function restoreSession() {
    const saved = readSavedSession();
    if (!saved) {
        showLoginScreen();
        hideBootLoader();
        return;
    }

    showLoading();

    // LOGIN REFRESH BUG FIX (mirrored from Resident Hub): a single failed
    // profile read on slow internet used to end the session ("Session ended")
    // on every refresh. Retry with a backoff buffer first, and if the network
    // still cannot deliver, KEEP the saved session and just ask the organizer
    // to refresh — only a confirmed invalid/disabled profile clears it.
    let snapshot = null;
    try {
        snapshot = await withRetryBuffer(
            () => getDoc(doc(db, "organizers", saved.id)),
            { retries: 3, baseDelay: 1500, label: "organizer session restore" },
        );
    } catch (networkError) {
        console.warn(
            "Organizer profile read failed after retries (network):",
            networkError?.code || networkError?.message,
        );
        hideLoading();
        hideBootLoader();
        showLoginScreen();
        showAlert(
            "Slow connection",
            "We could not verify your session right now. Your sign-in is preserved on this device — check your internet connection and refresh the page.",
        );
        return;
    }

    try {
        if (!snapshot.exists() || !isActiveOrganizer(snapshot.data())) {
            throw new Error("This organizer session is no longer valid.");
        }

        const profile = snapshot.data();
        state.session = {
            id: snapshot.id,
            email: normalizeEmail(profile.email) || normalizeEmail(saved.email) || "",
            name:
                profile.name || profile.displayName || saved.name || "Event Organizer",
            role: "organizer",
        };
        saveSession(state.session);
        showDashboard();
        startPortalListeners();
        // On reload, return to the tab the organizer was last viewing.
        const savedTab = localStorage.getItem(TAB_KEY);
        switchTab(ALLOWED_TABS.includes(savedTab) ? savedTab : "announcements");
    } catch (error) {
        console.warn("Saved organizer session rejected:", error);
        clearSession();
        stopPortalListeners();
        showLoginScreen();
        showAlert("Session ended", "Please sign in again to continue.");
    } finally {
        hideLoading();
        hideBootLoader();
    }
}

async function handleLogout() {
    const confirmed = await showConfirm(
        "Exit organizer console?",
        "Your live data session will be closed on this device.",
        "Exit console",
    );
    if (!confirmed) return;
    showLoading("Signing out…");
    try {
        stopPortalListeners();
        clearSession();
        state.events = [];
        state.announcements = [];
        state.volunteers = [];
        state.donations = [];
        state.participants = [];
        state.serviceHours = [];
        await new Promise((resolve) => setTimeout(resolve, 700));
        showLoginScreen();
    } finally {
        hideLoading();
    }
}

function resetAnnouncementForm() {
    $("announcement-form")?.reset();
    if ($("ann-id")) $("ann-id").value = "";
    if ($("ann-image")) $("ann-image").value = "";
    if ($("ann-image-file")) $("ann-image-file").value = "";
    if ($("ann-remove-image")) $("ann-remove-image").checked = false;

    state.editAnnouncementExistingImage = "";
    state.editAnnouncementExistingImageName = "";
    state.editAnnouncementExistingImageSource = "";

    $("announcement-modal-kicker").textContent = "Public broadcast";
    $("announcement-modal-title").textContent = "Post announcement";
    $("ann-image-help").textContent =
        "Leave the selected field empty if no image is needed.";
    $("ann-image-file-label").textContent =
        "Original retained when possible · high-quality optimization · 8 MB max";
    $("ann-remove-image-wrap").classList.add("hidden");
    $("ann-remove-image-wrap").classList.remove("flex");
    $("announcement-submit-button")
        ?.querySelector("i")
        ?.setAttribute("class", "fa-solid fa-bullhorn mr-2");
    $("announcement-submit-text").textContent = "Broadcast";
    setAnnouncementImageSource("url");
}

function openEditAnnouncement(id) {
    const announcement = state.announcements.find((record) => record.id === id);
    if (!announcement) {
        showAlert(
            "Announcement unavailable",
            "The selected announcement could not be found.",
        );
        return;
    }

    resetAnnouncementForm();
    const existingImage = safeImageUrl(
        announcement.imageUrl || announcement.image,
    );
    const existingWebUrl = safeWebUrl(existingImage);
    const existingSource = existingWebUrl
        ? "url"
        : existingImage
            ? "upload"
            : "url";

    state.editAnnouncementExistingImage = existingImage;
    state.editAnnouncementExistingImageName = announcement.imageFileName || "";
    state.editAnnouncementExistingImageSource = existingImage
        ? announcement.imageSource === "upload" && !existingWebUrl
            ? "upload"
            : existingSource
        : "";

    $("ann-id").value = id;
    $("ann-title").value = announcement.title || "";
    $("ann-priority").value = ["Normal", "Important", "Emergency"].includes(
        announcement.priority,
    )
        ? announcement.priority
        : "Normal";
    $("ann-desc").value = announcement.desc || announcement.description || "";
    $("ann-image").value = existingWebUrl || "";
    $("ann-image-file").value = "";
    $("ann-remove-image").checked = false;

    $("announcement-modal-kicker").textContent = "Public broadcast editor";
    $("announcement-modal-title").textContent = "Edit announcement";
    $("announcement-submit-button")
        ?.querySelector("i")
        ?.setAttribute("class", "fa-solid fa-floppy-disk mr-2");
    $("announcement-submit-text").textContent = "Save changes";

    if (existingImage) {
        $("ann-remove-image-wrap").classList.remove("hidden");
        $("ann-remove-image-wrap").classList.add("flex");
        if (existingSource === "upload") {
            $("ann-image-help").textContent =
                "The current uploaded image will be retained unless you attach a replacement or select Remove.";
            $("ann-image-file-label").textContent =
                `Current attachment: ${state.editAnnouncementExistingImageName || "uploaded announcement image"}. Choose a file only to replace it.`;
        } else {
            $("ann-image-help").textContent =
                "Edit the URL to replace the current image, or select Remove to delete it.";
        }
    } else {
        $("ann-image-help").textContent =
            "This announcement has no image. Add an optional URL or upload if needed.";
    }

    setAnnouncementImageSource(existingSource);
    openModal("announcement-modal");
}

async function handleAnnouncementSubmit(event) {
    event.preventDefault();
    try {
        requireOrganizerSession();
    } catch (error) {
        showAlert("Session required", error.message);
        return;
    }

    const id = $("ann-id")?.value || "";
    const isEditing = Boolean(id);
    const title = $("ann-title").value.trim();
    const priority = $("ann-priority").value;
    const desc = $("ann-desc").value.trim();
    if (!title || !desc) {
        showAlert(
            "Missing details",
            "Provide both an announcement title and message.",
        );
        return;
    }

    showLoading();
    try {
        const selectedSource = selectedAnnouncementImageSource();
        const imageFile = $("ann-image-file")?.files?.[0];
        const removeImage = isEditing && Boolean($("ann-remove-image")?.checked);
        let imageUrl = "";
        let imageSource = "";
        let imageFileName = "";

        if (!removeImage && selectedSource === "upload" && imageFile) {
            imageUrl = await prepareHighQualityImage(imageFile);
            imageSource = "upload";
            imageFileName = imageFile.name;
        } else if (
            !removeImage &&
            selectedSource === "url" &&
            $("ann-image").value.trim()
        ) {
            imageUrl = $("ann-image").value.trim();
            imageSource = "url";
        } else if (
            !removeImage &&
            isEditing &&
            state.editAnnouncementExistingImage
        ) {
            imageUrl = state.editAnnouncementExistingImage;
            imageSource =
                state.editAnnouncementExistingImageSource ||
                (safeWebUrl(imageUrl) ? "url" : "upload");
            imageFileName = state.editAnnouncementExistingImageName;
        }

        if (imageUrl && !safeImageUrl(imageUrl)) {
            showAlert(
                "Invalid announcement image",
                "Use a valid HTTP/HTTPS image URL or attach a JPG, PNG, or WebP file.",
            );
            return;
        }

        const payload = {
            title,
            priority,
            desc,
            imageUrl,
            imageSource: imageUrl ? imageSource : "",
            imageFileName: imageUrl ? imageFileName : "",
        };

        if (isEditing) {
            await updateDoc(doc(db, "announcements", id), {
                ...payload,
                image: "",
                updatedBy: getDisplayName(),
                updatedById: state.session.id,
                updatedByRole: "organizer",
                updatedAt: serverTimestamp(),
            });
            closeModal("announcement-modal");
            resetAnnouncementForm();
            showAlert(
                "Announcement updated",
                "The revised announcement is now visible to residents.",
                true,
            );
        } else {
            await addDoc(collection(db, "announcements"), {
                ...payload,
                createdBy: getDisplayName(),
                createdById: state.session.id,
                createdByRole: "organizer",
                createdAt: serverTimestamp(),
            });
            closeModal("announcement-modal");
            resetAnnouncementForm();
            showAlert(
                "Announcement dispatched",
                "The public announcement was posted successfully.",
                true,
            );
        }
    } catch (error) {
        showAlert(
            isEditing ? "Unable to update" : "Unable to post",
            error.message ||
            (isEditing
                ? "The announcement could not be updated."
                : "The announcement could not be posted."),
        );
    } finally {
        hideLoading();
    }
}

async function deleteAnnouncement(id) {
    const announcement = state.announcements.find((record) => record.id === id);
    if (!announcement) return;
    const confirmed = await showConfirm(
        "Delete announcement?",
        `“${announcement.title || "This announcement"}” will be permanently removed.`,
        "Delete",
    );
    if (!confirmed) return;

    showLoading();
    try {
        requireOrganizerSession();
        await deleteDoc(doc(db, "announcements", id));
        showAlert("Announcement deleted", "The announcement was removed.", true);
    } catch (error) {
        showAlert(
            "Unable to delete",
            error.message || "The announcement could not be removed.",
        );
    } finally {
        hideLoading();
    }
}

function setAnnouncementImageSource(source = "url") {
    const selected = document.querySelector(
        `input[name="ann-image-source"][value="${source}"]`,
    );
    if (selected) selected.checked = true;
    $("ann-image-url-panel")?.classList.toggle("hidden", source !== "url");
    $("ann-image-upload-panel")?.classList.toggle("hidden", source !== "upload");
}

function selectedAnnouncementImageSource() {
    return (
        document.querySelector('input[name="ann-image-source"]:checked')?.value ||
        "url"
    );
}

function setEventImageSource(prefix = "", source = "url") {
    const fieldName = prefix ? "edit-event-image-source" : "event-image-source";
    const selected = document.querySelector(
        `input[name="${fieldName}"][value="${source}"]`,
    );
    if (selected) selected.checked = true;
    $(`${prefix}event-image-url-panel`)?.classList.toggle(
        "hidden",
        source !== "url",
    );
    $(`${prefix}event-image-upload-panel`)?.classList.toggle(
        "hidden",
        source !== "upload",
    );
}

function selectedEventImageSource(prefix = "") {
    const fieldName = prefix ? "edit-event-image-source" : "event-image-source";
    return (
        document.querySelector(`input[name="${fieldName}"]:checked`)?.value || "url"
    );
}

function formatFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
    if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadLocalImage(file) {
    const objectUrl = URL.createObjectURL(file);
    try {
        return await new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () =>
                reject(new Error("The selected file is not a readable image."));
            image.src = objectUrl;
        });
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

function readLocalFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () =>
            reject(new Error("The selected image could not be read."));
        reader.readAsDataURL(file);
    });
}

async function prepareHighQualityImage(file) {
    const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
    if (!allowedTypes.includes(file.type)) {
        throw new Error("Attach a JPG, PNG, or WebP image file.");
    }
    if (file.size > 8 * 1024 * 1024) {
        throw new Error("The source image must not exceed 8 MB.");
    }

    const image = await loadLocalImage(file);
    const largestSide = Math.max(image.naturalWidth, image.naturalHeight);
    if (!largestSide)
        throw new Error("The selected image has invalid dimensions.");

    // Preserve the exact source bytes whenever the image already fits safely in
    // a Firestore document. Larger images receive a high-resolution WebP copy.
    const maximumDataUrlLength = 820000;
    const originalDataUrl = await readLocalFileAsDataUrl(file);
    if (originalDataUrl.length <= maximumDataUrlLength) return originalDataUrl;

    const baseScale = Math.min(1, 2560 / largestSide);
    const scaleLevels = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4];
    const qualityLevels = [0.96, 0.92, 0.88, 0.84];

    for (const scaleLevel of scaleLevels) {
        const scale = baseScale * scaleLevel;
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext("2d");
        if (!context)
            throw new Error("This browser cannot prepare the image attachment.");

        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);

        for (const quality of qualityLevels) {
            let dataUrl = canvas.toDataURL("image/webp", quality);
            if (!dataUrl.startsWith("data:image/webp")) {
                dataUrl = canvas.toDataURL("image/jpeg", quality);
            }
            if (dataUrl.length <= maximumDataUrlLength) return dataUrl;
        }
    }

    throw new Error(
        "The image cannot fit in Firestore at high quality. Please select a less detailed or smaller image.",
    );
}

async function eventPayload(prefix = "") {
    const getValue = (name) => $(`${prefix}${name}`)?.value?.trim() || "";
    const source = selectedEventImageSource(prefix);
    const file = $(`${prefix}event-image-file`)?.files?.[0];
    const removeImage =
        prefix === "edit-" && Boolean($("edit-event-remove-image")?.checked);
    let imageUrl = "";
    let imageFileName = "";

    if (!removeImage && source === "upload") {
        imageUrl = file
            ? await prepareHighQualityImage(file)
            : prefix === "edit-"
                ? state.editEventExistingImage
                : "";
        imageFileName =
            file?.name ||
            (prefix === "edit-" ? state.editEventExistingImageName : "");
    } else if (!removeImage) {
        imageUrl = getValue("event-image");
    }

    return {
        title: getValue("event-title"),
        date: getValue("event-date"),
        time: getValue("event-time"),
        location: getValue("event-location"),
        type: getValue("event-category"),
        imageUrl,
        imageSource: imageUrl ? source : "",
        imageFileName,
        desc: getValue("event-desc"),
    };
}

function validateEventPayload(payload) {
    if (
        !payload.title ||
        !payload.date ||
        !payload.location ||
        !payload.type ||
        !payload.desc
    ) {
        return "Complete all required event fields.";
    }
    if (payload.imageUrl && !safeImageUrl(payload.imageUrl)) {
        return "Use a valid HTTP/HTTPS image URL or attach a supported image file.";
    }
    return "";
}

async function handleEventSubmit(event) {
    event.preventDefault();
    showLoading();
    try {
        requireOrganizerSession();
        const payload = await eventPayload();
        const validationError = validateEventPayload(payload);
        if (validationError) {
            showAlert("Check event details", validationError);
            return;
        }
        await addDoc(collection(db, "events"), {
            ...payload,
            createdBy: getDisplayName(),
            createdById: state.session.id,
            createdByRole: "organizer",
            createdAt: serverTimestamp(),
        });
        $("event-form").reset();
        setEventImageSource("", "url");
        $("event-image-file-label").textContent =
            "Original retained when possible · high-quality optimization · 8 MB max";
        closeModal("event-modal");
        showAlert(
            "Event published",
            "The community event is now available in the schedule.",
            true,
        );
    } catch (error) {
        showAlert(
            "Unable to publish",
            error.message || "The event could not be created.",
        );
    } finally {
        hideLoading();
    }
}

function openEventDetails(id) {
    const eventRecord = state.events.find((record) => record.id === id);
    if (!eventRecord) return;

    $("details-category").textContent =
        eventRecord.type || eventRecord.category || "Event";
    $("details-title").textContent = eventRecord.title || "Untitled event";
    $("details-date").textContent =
        `${formatEventDate(eventRecord.date)}${eventRecord.time ? ` at ${formatTime(eventRecord.time)}` : ""}`;
    $("details-location").textContent =
        eventRecord.location || "Location to be announced";
    $("details-description").textContent =
        eventRecord.desc || eventRecord.description || "No description provided.";
    $("details-author").textContent =
        `Created by ${eventRecord.createdBy || "Organizer"}`;

    const imageUrl = safeImageUrl(eventRecord.imageUrl);
    if (imageUrl) {
        $("details-image").src = imageUrl;
        $("details-image-wrap").classList.remove("hidden");
    } else {
        $("details-image").removeAttribute("src");
        $("details-image-wrap").classList.add("hidden");
    }
    openModal("event-details-modal");
}

function openEditEvent(id) {
    const eventRecord = state.events.find((record) => record.id === id);
    if (!eventRecord) return;
    $("edit-event-id").value = id;
    $("edit-event-title").value = eventRecord.title || "";
    $("edit-event-date").value = eventRecord.date || "";
    $("edit-event-time").value = eventRecord.time || "";
    $("edit-event-location").value = eventRecord.location || "";
    $("edit-event-category").value =
        eventRecord.type || eventRecord.category || "";
    state.editEventExistingImage = safeImageUrl(eventRecord.imageUrl) || "";
    state.editEventExistingImageName = eventRecord.imageFileName || "";
    const existingWebUrl = safeWebUrl(eventRecord.imageUrl);
    const hasUploadedImage = Boolean(
        state.editEventExistingImage && !existingWebUrl,
    );
    $("edit-event-image").value = existingWebUrl || "";
    $("edit-event-image-file").value = "";
    $("edit-event-remove-image").checked = false;
    $("edit-event-image-file-label").textContent = hasUploadedImage
        ? `Current attachment: ${state.editEventExistingImageName || "uploaded event image"}. Choose a new file only to replace it.`
        : "Choose a file only when replacing the current image.";
    setEventImageSource("edit-", hasUploadedImage ? "upload" : "url");
    $("edit-event-desc").value =
        eventRecord.desc || eventRecord.description || "";
    openModal("edit-event-modal");
}

async function handleEditEventSubmit(event) {
    event.preventDefault();
    const id = $("edit-event-id").value;
    showLoading();
    try {
        requireOrganizerSession();
        const payload = await eventPayload("edit-");
        const validationError = validateEventPayload(payload);
        if (!id || validationError) {
            showAlert(
                "Check event details",
                validationError || "No event is selected.",
            );
            return;
        }
        await updateDoc(doc(db, "events", id), {
            ...payload,
            updatedBy: getDisplayName(),
            updatedById: state.session.id,
            updatedByRole: "organizer",
            updatedAt: serverTimestamp(),
        });
        closeModal("edit-event-modal");
        showAlert("Event updated", "The revised event details were saved.", true);
    } catch (error) {
        showAlert(
            "Unable to update",
            error.message || "The event could not be updated.",
        );
    } finally {
        hideLoading();
    }
}

async function deleteInBatches(documentRefs) {
    const chunkSize = 450;
    for (let index = 0; index < documentRefs.length; index += chunkSize) {
        const batch = writeBatch(db);
        documentRefs
            .slice(index, index + chunkSize)
            .forEach((documentRef) => batch.delete(documentRef));
        await batch.commit();
    }
}

async function deleteEvent(id) {
    const eventRecord = state.events.find((record) => record.id === id);
    if (!eventRecord) return;
    const confirmed = await showConfirm(
        "Delete event?",
        `“${eventRecord.title || "This event"}” and all linked registrations will be permanently removed.`,
        "Delete event",
    );
    if (!confirmed) return;

    showLoading();
    try {
        requireOrganizerSession();
        const registrations = await getDocs(
            query(collection(db, "participants"), where("eventId", "==", id)),
        );
        const refs = [
            doc(db, "events", id),
            ...registrations.docs.map((registration) => registration.ref),
        ];
        await deleteInBatches(refs);
        showAlert(
            "Event deleted",
            `${eventRecord.title || "The event"} and ${registrations.size} linked registration${registrations.size === 1 ? "" : "s"} were removed.`,
            true,
        );
    } catch (error) {
        showAlert(
            "Unable to delete",
            error.message || "The event could not be deleted.",
        );
    } finally {
        hideLoading();
    }
}

async function updateVolunteerStatus(id, newStatus) {
    const volunteer = state.volunteers.find((record) => record.id === id);
    if (
        !volunteer ||
        ![STATUS.PENDING, STATUS.APPROVED, STATUS.REJECTED].includes(newStatus)
    )
        return;
    const label =
        newStatus === STATUS.APPROVED
            ? "approve"
            : newStatus === STATUS.REJECTED
                ? "reject"
                : "reset";
    const confirmed = await showConfirm(
        `${label[0].toUpperCase()}${label.slice(1)} application?`,
        `${volunteer.name || "This volunteer"}'s application will be marked ${newStatus.toLowerCase()}.`,
        `${label[0].toUpperCase()}${label.slice(1)}`,
    );
    if (!confirmed) return;

    showLoading();
    try {
        requireOrganizerSession();
        await updateDoc(doc(db, "volunteers", id), {
            status: newStatus,
            reviewedBy: getDisplayName(),
            reviewedById: state.session.id,
            reviewedByRole: "organizer",
            reviewedAt: serverTimestamp(),
        });
        if (volunteer.residentId) {
            const messageStatus =
                newStatus === STATUS.APPROVED
                    ? "approved"
                    : newStatus === STATUS.REJECTED
                        ? "rejected"
                        : "returned to pending review";
            await createNotification(
                volunteer.residentId,
                `Volunteer application ${messageStatus}`,
                `Your volunteer application was ${messageStatus} by ${getDisplayName()}.`,
                newStatus === STATUS.APPROVED
                    ? "volunteer_approved"
                    : newStatus === STATUS.REJECTED
                        ? "volunteer_rejected"
                        : "general",
            );
        }
        showAlert(
            "Application updated",
            `${volunteer.name || "The volunteer"} is now marked ${newStatus.toLowerCase()}.`,
            true,
        );
    } catch (error) {
        showAlert(
            "Unable to update",
            error.message || "The volunteer application could not be updated.",
        );
    } finally {
        hideLoading();
    }
}

async function bulkApproveVolunteers() {
    const pending = state.volunteers.filter(
        (volunteer) => (volunteer.status || STATUS.PENDING) === STATUS.PENDING,
    );
    if (!pending.length) {
        showAlert(
            "Nothing to approve",
            "There are no pending volunteer applications.",
            true,
        );
        return;
    }
    const confirmed = await showConfirm(
        "Approve all pending volunteers?",
        `${pending.length} application${pending.length === 1 ? "" : "s"} will be approved.`,
        "Approve all",
    );
    if (!confirmed) return;

    showLoading();
    try {
        requireOrganizerSession();
        const chunkSize = 450;
        for (let index = 0; index < pending.length; index += chunkSize) {
            const batch = writeBatch(db);
            pending.slice(index, index + chunkSize).forEach((volunteer) => {
                batch.update(doc(db, "volunteers", volunteer.id), {
                    status: STATUS.APPROVED,
                    reviewedBy: getDisplayName(),
                    reviewedById: state.session.id,
                    reviewedByRole: "organizer",
                    reviewedAt: serverTimestamp(),
                });
            });
            await batch.commit();
        }
        await Promise.allSettled(
            pending
                .filter((volunteer) => volunteer.residentId)
                .map((volunteer) =>
                    createNotification(
                        volunteer.residentId,
                        "Volunteer application approved",
                        `Your volunteer application was approved by ${getDisplayName()}.`,
                        "volunteer_approved",
                    ),
                ),
        );
        showAlert(
            "Applications approved",
            `${pending.length} volunteer application${pending.length === 1 ? " was" : "s were"} approved.`,
            true,
        );
    } catch (error) {
        showAlert(
            "Bulk approval failed",
            error.message || "The applications could not be approved.",
        );
    } finally {
        hideLoading();
    }
}

function showVolunteerNotes(id) {
    const volunteer = state.volunteers.find((record) => record.id === id);
    if (!volunteer?.notes) return;
    const root = $("dynamic-modal-root");
    root.innerHTML = `<div class="fixed inset-0 bg-slate-950/65 backdrop-blur-sm flex items-center justify-center p-4 z-[180]" data-dynamic-backdrop>
    <div class="modal-panel bg-white rounded-2xl max-w-lg w-full shadow-2xl border border-slate-200 p-6">
      <div class="flex items-center justify-between gap-4"><div><p class="text-xs uppercase tracking-wider font-bold text-amber-600">Volunteer notes</p><h3 class="text-lg font-extrabold text-victoria-blue mt-1">${escapeHtml(volunteer.name || "Volunteer")}</h3></div><button type="button" data-dynamic-close class="w-9 h-9 rounded-lg text-slate-400 hover:bg-slate-100"><i class="fa-solid fa-xmark"></i></button></div>
      <p class="mt-5 bg-amber-50/60 border border-amber-100 rounded-xl p-4 text-sm text-slate-700 leading-relaxed whitespace-pre-line max-h-72 overflow-y-auto">${escapeHtml(volunteer.notes)}</p>
      <button type="button" data-dynamic-close class="mt-5 w-full bg-slate-100 text-slate-700 font-semibold py-2.5 rounded-xl text-sm hover:bg-slate-200">Close</button>
    </div>
  </div>`;
}

async function viewVerificationFile(id) {
    showLoading();
    try {
        requireOrganizerSession();
        const snapshot = await getDoc(doc(db, "volunteers", id));
        if (!snapshot.exists() || !snapshot.data().verificationFile?.data) {
            showAlert(
                "No document",
                "This volunteer did not submit a verification file.",
            );
            return;
        }

        const volunteer = snapshot.data();
        const file = volunteer.verificationFile;
        const fileUrl = safeFileUrl(file.data);
        if (!fileUrl) {
            showAlert(
                "Unsupported document",
                "The stored document URL is not safe to display.",
            );
            return;
        }
        const fileName = file.fileName || "verification-document";
        const fileType = String(file.fileType || "").toLowerCase();
        const isImage =
            fileType.startsWith("image/") ||
            /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(fileName);
        const isPdf = fileType === "application/pdf" || /\.pdf$/i.test(fileName);

        const root = $("dynamic-modal-root");
        root.innerHTML = `<div class="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 z-[320]" data-dynamic-backdrop>
      <div class="modal-panel bg-white rounded-2xl max-w-4xl w-full max-h-[92vh] shadow-2xl border border-slate-200 flex flex-col overflow-hidden">
        <div class="p-5 border-b flex items-center justify-between gap-4 shrink-0"><div><p class="text-xs uppercase tracking-wider font-bold text-victoria-accent">Verification document</p><h3 class="font-extrabold text-victoria-blue mt-1">${escapeHtml(fileName)}</h3><p class="text-xs text-slate-400 mt-0.5">Submitted by ${escapeHtml(volunteer.name || "Volunteer")}</p></div><button type="button" data-dynamic-close class="w-9 h-9 rounded-lg text-slate-400 hover:bg-slate-100"><i class="fa-solid fa-xmark"></i></button></div>
        <div id="verification-preview" class="flex-1 bg-slate-100 min-h-[420px] overflow-auto flex items-center justify-center p-4"></div>
      </div>
    </div>`;

        const preview = $("verification-preview");
        if (isImage) {
            const image = document.createElement("img");
            image.src = fileUrl;
            image.alt = fileName;
            image.className =
                "max-w-full max-h-[65vh] object-contain rounded-lg shadow";
            preview.appendChild(image);
        } else if (isPdf) {
            const embed = document.createElement("embed");
            embed.src = fileUrl;
            embed.type = "application/pdf";
            embed.className = "w-full h-[65vh] bg-white rounded-lg";
            preview.appendChild(embed);
        } else {
            preview.innerHTML =
                '<div class="text-center text-slate-500"><i class="fa-solid fa-file-arrow-down text-5xl text-victoria-blue"></i><p class="font-bold mt-4">Preview unavailable</p><p class="text-sm mt-1">Use the download button in the volunteers table to save this file.</p></div>';
        }
    } catch (error) {
        showAlert(
            "Unable to open document",
            error.message || "The verification document could not be loaded.",
        );
    } finally {
        hideLoading();
    }
}

function downloadStoredFile(dataUrl, fileName) {
    try {
        const parts = String(dataUrl).split(",");
        const mime =
            (parts[0].match(/data:(.*?);/) || [])[1] || "application/octet-stream";
        const byteString = atob(parts[1] || "");
        const bytes = new Uint8Array(byteString.length);
        for (let i = 0; i < byteString.length; i++)
            bytes[i] = byteString.charCodeAt(i);
        const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    } catch {
        const link = document.createElement("a");
        link.href = dataUrl;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }
}

async function downloadVerificationFile(id) {
    showLoading();
    try {
        requireOrganizerSession();
        const snapshot = await getDoc(doc(db, "volunteers", id));
        if (!snapshot.exists() || !snapshot.data().verificationFile?.data) {
            showAlert(
                "No document",
                "This volunteer did not submit a verification file.",
            );
            return;
        }
        const file = snapshot.data().verificationFile;
        const fileName = file.fileName || "verification-document";
        downloadStoredFile(file.data, fileName);
        showAlert("Download started", `${fileName} is downloading.`, true);
    } catch (error) {
        showAlert(
            "Unable to download",
            error.message || "The verification document could not be downloaded.",
        );
    } finally {
        hideLoading();
    }
}

async function updateDonationStatus(id, newStatus) {
    const donation = state.donations.find((record) => record.id === id);
    if (
        !donation ||
        ![STATUS.PENDING, STATUS.APPROVED, STATUS.REJECTED].includes(newStatus)
    )
        return;
    const displayStatus =
        newStatus === STATUS.APPROVED ? "confirmed" : newStatus.toLowerCase();
    const confirmed = await showConfirm(
        "Update donation status?",
        `${donation.donorName || "This donation"} will be marked ${displayStatus}.`,
        "Update",
    );
    if (!confirmed) return;

    showLoading();
    try {
        requireOrganizerSession();
        await updateDoc(doc(db, "donations", id), {
            status: newStatus,
            reviewedBy: getDisplayName(),
            reviewedById: state.session.id,
            reviewedByRole: "organizer",
            reviewedAt: serverTimestamp(),
        });
        if (donation.donorId) {
            await createNotification(
                donation.donorId,
                `Donation ${displayStatus}`,
                `Your donation was ${displayStatus} by ${getDisplayName()}.`,
                newStatus === STATUS.APPROVED
                    ? "donation_confirmed"
                    : newStatus === STATUS.REJECTED
                        ? "donation_rejected"
                        : "general",
            );
        }
        showAlert(
            "Donation updated",
            `The donation is now marked ${displayStatus}.`,
            true,
        );
    } catch (error) {
        showAlert(
            "Unable to update",
            error.message || "The donation status could not be changed.",
        );
    } finally {
        hideLoading();
    }
}

async function handleHourSubmit(event) {
    event.preventDefault();
    const participantId = $("hour-participant-select").value;
    const hours = Number($("hour-value").value);
    const participant = state.participants.find(
        (record) => record.id === participantId,
    );
    if (!participant) {
        showAlert(
            "Select a participant",
            "Choose an active event registration from the list.",
        );
        return;
    }
    if (!Number.isFinite(hours) || hours < 0.5 || hours > 24) {
        showAlert("Invalid hours", "Enter a value from 0.5 to 24 hours.");
        return;
    }

    const confirmed = await showConfirm(
        "Authorize service hours?",
        `${hours} hour${hours === 1 ? "" : "s"} will be credited to ${participant.residentName || "this resident"} for ${participant.eventTitle || "the event"}.`,
        "Authorize",
    );
    if (!confirmed) return;

    showLoading();
    try {
        requireOrganizerSession();
        const serviceHourRef = doc(collection(db, "service_hours"));
        const participantRef = doc(db, "participants", participantId);
        const batch = writeBatch(db);
        batch.set(serviceHourRef, {
            residentId: participant.residentId || "",
            residentName: participant.residentName || "Unknown resident",
            eventTitle: participant.eventTitle || "Unknown event",
            eventId: participant.eventId || "",
            hours,
            status: STATUS.APPROVED,
            certifiedBy: getDisplayName(),
            certifiedById: state.session.id,
            certifiedByRole: "organizer",
            certifiedAt: serverTimestamp(),
        });
        batch.update(participantRef, {
            status: STATUS.COMPLETED,
            completedAt: serverTimestamp(),
            completedBy: getDisplayName(),
            completedById: state.session.id,
            hoursCredited: hours,
        });
        await batch.commit();
        await createNotification(
            participant.residentId,
            "Service hours credited",
            `${hours} hour${hours === 1 ? "" : "s"} credited for “${participant.eventTitle || "your event"}”.`,
            "hours_credited",
        );
        $("hour-form").reset();
        showAlert(
            "Hours certified",
            `${hours} hour${hours === 1 ? " was" : "s were"} credited successfully.`,
            true,
        );
    } catch (error) {
        showAlert(
            "Unable to certify",
            error.message || "The service hours could not be recorded.",
        );
    } finally {
        hideLoading();
    }
}

async function handleAction(button) {
    const { action, id, status } = button.dataset;
    switch (action) {
        case "view-event":
            openEventDetails(id);
            break;
        case "edit-event":
            openEditEvent(id);
            break;
        case "delete-event":
            await deleteEvent(id);
            break;
        case "edit-announcement":
            openEditAnnouncement(id);
            break;
        case "delete-announcement":
            await deleteAnnouncement(id);
            break;
        case "volunteer-status":
            await updateVolunteerStatus(id, status);
            break;
        case "view-volunteer-notes":
            showVolunteerNotes(id);
            break;
        case "view-verification":
            await viewVerificationFile(id);
            break;
        case "download-verification":
            await downloadVerificationFile(id);
            break;
        case "donation-status":
            await updateDonationStatus(id, status);
            break;
        default:
            break;
    }
}

function setActivityFilter(filter, clickedButton) {
    state.activityFilter = filter;
    document.querySelectorAll(".activity-filter").forEach((button) => {
        const active = button === clickedButton;
        button.classList.toggle("bg-victoria-blue", active);
        button.classList.toggle("text-white", active);
        button.classList.toggle("bg-slate-100", !active);
        button.classList.toggle("text-slate-600", !active);
    });
    renderActivityLogs();
}

function bindStaticEvents() {
    $("login-form")?.addEventListener("submit", handleLogin);
    $("announcement-form")?.addEventListener("submit", handleAnnouncementSubmit);
    $("event-form")?.addEventListener("submit", handleEventSubmit);
    $("edit-event-form")?.addEventListener("submit", handleEditEventSubmit);
    $("hour-form")?.addEventListener("submit", handleHourSubmit);
    $("logout-btn")?.addEventListener("click", handleLogout);
    $("bulk-approve-btn")?.addEventListener("click", bulkApproveVolunteers);
    $("open-announcement-modal")?.addEventListener("click", () => {
        resetAnnouncementForm();
        openModal("announcement-modal");
    });
    $("open-event-modal")?.addEventListener("click", () => {
        $("event-form").reset();
        setEventImageSource("", "url");
        $("event-image-file-label").textContent =
            "Original retained when possible · high-quality optimization · 8 MB max";
        openModal("event-modal");
    });

    document
        .querySelectorAll('input[name="ann-image-source"]')
        .forEach((radio) => {
            radio.addEventListener("change", () =>
                setAnnouncementImageSource(radio.value),
            );
        });
    $("ann-image-file")?.addEventListener("change", (event) => {
        const file = event.target.files?.[0];
        $("ann-image-file-label").textContent = file
            ? `${file.name} · ${formatFileSize(file.size)}`
            : "Original retained when possible · high-quality optimization · 8 MB max";
    });

    document
        .querySelectorAll('input[name="event-image-source"]')
        .forEach((radio) => {
            radio.addEventListener("change", () =>
                setEventImageSource("", radio.value),
            );
        });
    document
        .querySelectorAll('input[name="edit-event-image-source"]')
        .forEach((radio) => {
            radio.addEventListener("change", () =>
                setEventImageSource("edit-", radio.value),
            );
        });
    $("event-image-file")?.addEventListener("change", (event) => {
        const file = event.target.files?.[0];
        $("event-image-file-label").textContent = file
            ? `${file.name} · ${formatFileSize(file.size)}`
            : "Original retained when possible · high-quality optimization · 8 MB max";
    });
    $("edit-event-image-file")?.addEventListener("change", (event) => {
        const file = event.target.files?.[0];
        $("edit-event-image-file-label").textContent = file
            ? `${file.name} · ${formatFileSize(file.size)} · replaces the current image`
            : "Choose a file only when replacing the current image.";
    });
    $("volunteer-filter")?.addEventListener("change", renderVolunteers);
    $("volunteer-sort")?.addEventListener("change", renderVolunteers);
    $("donation-filter")?.addEventListener("change", renderDonations);
    $("donation-sort")?.addEventListener("change", renderDonations);
    $("alert-close-btn")?.addEventListener("click", () =>
        closeModal("organizer-alert-modal"),
    );
    $("confirm-cancel-btn")?.addEventListener("click", () =>
        resolveConfirm(false),
    );
    $("confirm-proceed-btn")?.addEventListener("click", () =>
        resolveConfirm(true),
    );

    $("toggle-password")?.addEventListener("click", () => {
        const input = $("login-password");
        const button = $("toggle-password");
        const reveal = input.type === "password";
        input.type = reveal ? "text" : "password";
        button.innerHTML = reveal
            ? '<i class="fa-solid fa-eye-slash"></i>'
            : '<i class="fa-solid fa-eye"></i>';
        button.setAttribute(
            "aria-label",
            reveal ? "Hide password" : "Show password",
        );
    });

    document.addEventListener("click", async (event) => {
        const navButton = event.target.closest("[data-tab]");
        if (navButton) {
            switchTab(navButton.dataset.tab);
            return;
        }

        const closeButton = event.target.closest("[data-close-modal]");
        if (closeButton) {
            closeModal(closeButton.dataset.closeModal);
            return;
        }

        const activityButton = event.target.closest(".activity-filter");
        if (activityButton) {
            setActivityFilter(activityButton.dataset.filter || "all", activityButton);
            return;
        }

        const dynamicClose = event.target.closest("[data-dynamic-close]");
        if (dynamicClose) {
            $("dynamic-modal-root").innerHTML = "";
            return;
        }

        if (event.target.matches("[data-dynamic-backdrop]")) {
            $("dynamic-modal-root").innerHTML = "";
            return;
        }

        const actionButton = event.target.closest("[data-action]");
        if (actionButton) {
            try {
                await handleAction(actionButton);
            } catch (error) {
                console.error("Organizer action failed:", error);
                hideLoading();
                showAlert(
                    "Action failed",
                    error.message || "The requested action could not be completed.",
                );
            }
        }
    });

    document
        .querySelectorAll("[data-close-on-backdrop='true']")
        .forEach((modal) => {
            modal.addEventListener("click", (event) => {
                if (event.target === modal) closeModal(modal.id);
            });
        });

    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        if (!$("confirm-modal").classList.contains("hidden")) {
            resolveConfirm(false);
            return;
        }
        if (!$("organizer-alert-modal").classList.contains("hidden")) {
            closeModal("organizer-alert-modal");
            return;
        }
        if ($("dynamic-modal-root").innerHTML) {
            $("dynamic-modal-root").innerHTML = "";
            return;
        }
        [
            "event-modal",
            "edit-event-modal",
            "announcement-modal",
            "event-details-modal",
        ].forEach((id) => closeModal(id));
    });
}

async function initializePortal() {
    if (initialized) return;
    initialized = true;
    // BOOT LOADER (mirrored from Resident Hub): keep the branded overlay up
    // until the session buffer finishes, with slow-connection messaging.
    showBootLoader();
    bindStaticEvents();
    await restoreSession();
    hideBootLoader();
}

document.addEventListener("DOMContentLoaded", initializePortal, { once: true });


// ===== PRINT FIXES (mirrors Admin fixes) =====
window.printOrganizerServiceHours = function () {
    const hoursTbody = document.getElementById("organizer-hours-tbody");
    const logsTbody = document.getElementById("activity-logs-tbody");
    let source = null;
    let rows = [];
    if (hoursTbody) {
        const allRows = hoursTbody.querySelectorAll("tr");
        const filtered = Array.from(allRows).filter((r) => {
            if (r.style.display === "none") return false;
            const cells = r.querySelectorAll("td");
            if (cells.length === 1 && cells[0].hasAttribute("colspan")) return false;
            return cells.length >= 4;
        });
        if (filtered.length > 0) { source = "hours"; rows = filtered; }
    }
    if (source !== "hours" && logsTbody) {
        const logRows = logsTbody.querySelectorAll("tr");
        const filtered = Array.from(logRows).filter((r) => {
            if (r.style.display === "none") return false;
            const cells = r.querySelectorAll("td");
            if (cells.length === 1 && cells[0].hasAttribute("colspan")) return false;
            return cells.length >= 4;
        });
        if (filtered.length > 0) { source = "logs"; rows = filtered; }
    }
    if (!source || rows.length === 0) { showAlert("No Data", "No service hours to print."); return; }
    const n = new Date();
    const ds = n.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const ts = n.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    const pw = window.open("", "_blank");
    if (!pw) { showAlert("Popup Blocked", "Please allow popups to print."); return; }
    let bodyRows = "";
    if (source === "hours") {
        bodyRows = rows.map((r) => {
            const c = r.querySelectorAll("td");
            const residentName = (c[0]?.textContent || "").trim();
            const eventTitle = c[1]?.textContent.trim() || "";
            const creditedHours = c[2]?.textContent.trim() || "";
            const status = c[3]?.textContent.trim() || "";
            const certCell = c[4];
            let dateTime = "";
            if (certCell) {
                const divs = certCell.querySelectorAll("p");
                if (divs.length >= 2) dateTime = divs[1].textContent.trim();
                else if (divs.length === 1) dateTime = divs[0].textContent.trim();
                else dateTime = certCell.textContent.trim().split("\n").pop().trim();
            }
            const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            return `<tr><td>${esc(residentName)}</td><td>${esc(eventTitle)}</td><td style="text-align:center;font-weight:800">${esc(creditedHours)}</td><td>${esc(dateTime)}</td><td>${esc(status)}</td></tr>`;
        }).join("");
    } else {
        bodyRows = rows.map((r) => {
            const c = r.querySelectorAll("td");
            if (c.length >= 5) {
                const residentName = (c[0]?.textContent || "").trim();
                const eventTitle = c[1]?.textContent.trim() || "";
                const activity = c[2]?.textContent.trim() || "";
                const dateTime = c[3]?.textContent.trim() || "";
                const status = c[4]?.textContent.trim() || "";
                const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                return `<tr><td>${esc(residentName)}</td><td>${esc(eventTitle)}</td><td style="text-align:center;font-weight:700">${esc(activity)}</td><td>${esc(dateTime)}</td><td>${esc(status)}</td></tr>`;
            }
            return "";
        }).join("");
    }
    pw.document.write(`<!DOCTYPE html><html><head><title>Service Hours Report</title><style>body{font-family:Arial,Helvetica,sans-serif;padding:24px;color:#1e293b}.header{text-align:center;margin-bottom:28px;border-bottom:3px solid #003B71;padding-bottom:18px}.header h1{color:#003B71;margin:0;font-size:22px;font-weight:900}.header p{color:#64748b;margin:6px 0;font-size:13px}.header .badge{display:inline-block;margin-top:8px;padding:6px 12px;background:#f1f5f9;border-radius:4px;font-size:11px;font-weight:800;color:#003B71}table{width:100%;border-collapse:collapse;margin-top:18px;font-size:12px}th{background:#003B71;color:#fff;padding:12px 10px;text-align:left;font-size:11px;text-transform:uppercase}th.center{text-align:center}td{padding:10px;border-bottom:1px solid #e2e8f0;font-size:12.5px}tr:nth-child(even){background:#f8fafc}.footer{margin-top:28px;text-align:center;font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:14px}@media print{body{padding:0}}</style></head><body><div class="header"><h1>Municipality of Victoria</h1><p>Service Hours Report</p><p>${ds} at ${ts}</p><p>Generated by: ${getDisplayName()}</p><span class="badge">${rows.length} record(s)</span></div><table><thead><tr><th>Resident Name</th><th>Event</th><th style="text-align:center">Credited Hours</th><th>Date &amp; Time</th><th>Status</th></tr></thead><tbody>${bodyRows}</tbody></table><div class="footer"><p>Official Service Hours Report — Victoria Civic Portal</p><p>Generated: ${ds} at ${ts}</p></div><script>window.onload=function(){setTimeout(function(){window.print()},400)}<\/script></body></html>`);
    pw.document.close();
};
window.printOrganizerDonations = function () {
    const tbody = document.getElementById("organizer-donations-tbody");
    if (!tbody) return;
    const rows = tbody.querySelectorAll("tr");
    const vr = Array.from(rows).filter((r) => {
        if (r.style.display === "none") return false;
        const cells = r.querySelectorAll("td");
        if (cells.length === 1 && cells[0].hasAttribute("colspan")) return false;
        return cells.length >= 5;
    });
    if (vr.length === 0) { showAlert("No Data", "No donations to print."); return; }
    const n = new Date();
    const ds = n.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const ts = n.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    const pw = window.open("", "_blank");
    if (!pw) { showAlert("Popup Blocked", "Please allow popups to print."); return; }
    const bodyRows = vr.map((r) => {
        const c = r.querySelectorAll("td");
        // Organizer donations has 6 columns: Donor, Resource, Proof, Purpose, Date, Status -> print 5 correctly (skip Proof)
        if (c.length >= 6)
            return `<tr><td>${c[0]?.textContent.trim() || ""}</td><td>${c[1]?.textContent.trim() || ""}</td><td>${c[3]?.textContent.trim() || ""}</td><td>${c[4]?.textContent.trim() || ""}</td><td>${c[5]?.textContent.trim() || ""}</td></tr>`;
        if (c.length >= 5)
            return `<tr><td>${c[0]?.textContent.trim() || ""}</td><td>${c[1]?.textContent.trim() || ""}</td><td>${c[2]?.textContent.trim() || ""}</td><td>${c[3]?.textContent.trim() || ""}</td><td>${c[4]?.textContent.trim() || ""}</td></tr>`;
        return "";
    }).join("");
    pw.document.write(`<!DOCTYPE html><html><head><title>Donations Report</title><style>body{font-family:Arial;padding:20px;color:#333}.header{text-align:center;margin-bottom:30px;border-bottom:2px solid #003B71;padding-bottom:20px}.header h1{color:#003B71;margin:0;font-size:24px}.header p{color:#666;margin:5px 0;font-size:14px}table{width:100%;border-collapse:collapse;margin-top:20px}th{background:#003B71;color:white;padding:12px;text-align:left;font-size:12px}td{padding:10px 12px;border-bottom:1px solid #ddd;font-size:13px}tr:nth-child(even){background:#f9f9f9}.footer{margin-top:30px;text-align:center;font-size:12px;color:#999}@media print{body{padding:0}}</style></head><body><div class="header"><h1>Municipality of Victoria</h1><p>Donations Report</p><p>All Donations | ${ds} at ${ts}</p><p>Generated by: ${getDisplayName()}</p></div><table><thead><tr><th>Donor Name</th><th>Resource</th><th>Purpose</th><th>Date</th><th>Status</th></tr></thead><tbody>${bodyRows}</tbody></table><div class="footer"><p>Official Donations Report</p><p>Generated: ${ds} at ${ts}</p></div></body></html>`);
    pw.document.close();
    setTimeout(() => pw.print(), 500);
};


// ===== DONATION PAYMENT SCREENSHOT HELPERS =====
function formatPaymentMethodName(method) {
    if (!method) return "E-Wallet / Bank";
    const m = String(method).toLowerCase();
    if (m === "gcash") return "GCash";
    if (m === "paymaya" || m === "maya") return "PayMaya / Maya";
    if (m === "bank_transfer" || m === "bank") return "Bank Transfer";
    if (m === "cash" || m === "cash payment") return "Cash Payment";
    return method.charAt(0).toUpperCase() + method.slice(1);
}

function openDonationScreenshotModal(donationId) {
    const donation = state.donations.find(
        (d) => String(d.id) === String(donationId),
    );
    if (!donation) return;

    const modal = $("donation-screenshot-modal");
    if (!modal) return;

    const donorNameEl = $("proof-donor-name");
    const amountEl = $("proof-amount");
    const methodEl = $("proof-method");
    const txEl = $("proof-tx-id");
    const imgEl = $("proof-screenshot-img");
    const noImgEl = $("proof-no-img-msg");
    const downloadBtn = $("proof-download-btn");
    const actionsLeft = $("proof-modal-actions-left");

    if (donorNameEl) donorNameEl.textContent = donation.donorName || "Anonymous";
    if (amountEl) amountEl.textContent = formatDonationResource(donation);
    if (methodEl)
        methodEl.textContent = formatPaymentMethodName(
            donation.paymentMethod || "E-Wallet",
        );
    if (txEl)
        txEl.textContent =
            donation.transactionId || donation.txId || donation.id || "N/A";
    // PAYMENT REQUIRED FIELDS (mirrored): show the reference number the donor
    // typed from their GCash/Maya/bank receipt so it can be cross-checked.
    const userRefEl = $("proof-user-ref");
    if (userRefEl) {
        userRefEl.textContent = donation.userReferenceNumber || "Not provided";
        userRefEl.classList.toggle("text-rose-500", !donation.userReferenceNumber);
    }

    const screenshotUrl = safeImageUrl(
        donation.paymentScreenshot ||
        donation.screenshot ||
        donation.proofOfPayment ||
        "",
    );
    if (screenshotUrl) {
        if (imgEl) {
            imgEl.src = screenshotUrl;
            imgEl.classList.remove("hidden");
        }
        if (noImgEl) noImgEl.classList.add("hidden");
        if (downloadBtn) {
            downloadBtn.href = screenshotUrl;
            downloadBtn.download = `Donation-Receipt-${donation.id}.png`;
            downloadBtn.classList.remove("hidden");
        }
    } else {
        if (imgEl) {
            imgEl.src = "";
            imgEl.classList.add("hidden");
        }
        if (noImgEl) noImgEl.classList.remove("hidden");
        if (downloadBtn) downloadBtn.classList.add("hidden");
    }

    if (actionsLeft) {
        // REJECTION BUG FIX: normalized status drives the modal actions.
        const status = effectiveStatus(donation);
        let btns = "";
        if (status !== STATUS.APPROVED) {
            btns += `<button type="button" data-action="donation-status" data-id="${escapeHtml(donation.id)}" data-status="${STATUS.APPROVED}" onclick="updateDonationStatusFromProof('${escapeHtml(donation.id)}', '${STATUS.APPROVED}')" class="text-xs font-bold bg-emerald-600 text-white px-3.5 py-2 rounded-xl hover:bg-emerald-700 shadow-sm flex items-center gap-1.5"><i class="fa-solid fa-check"></i>Confirm Payment</button>`;
        }
        if (status !== STATUS.REJECTED) {
            btns += `<button type="button" data-action="donation-status" data-id="${escapeHtml(donation.id)}" data-status="${STATUS.REJECTED}" onclick="updateDonationStatusFromProof('${escapeHtml(donation.id)}', '${STATUS.REJECTED}')" class="text-xs font-bold bg-rose-600 text-white px-3.5 py-2 rounded-xl hover:bg-rose-700 shadow-sm flex items-center gap-1.5"><i class="fa-solid fa-xmark"></i>Reject Payment</button>`;
        }
        actionsLeft.innerHTML = btns;
    }

    modal.classList.remove("hidden");
    modal.classList.add("flex");
}

function closeDonationScreenshotModal() {
    const modal = $("donation-screenshot-modal");
    if (modal) {
        modal.classList.add("hidden");
        modal.classList.remove("flex");
    }
}

function updateDonationStatusFromProof(donationId, newStatus) {
    closeDonationScreenshotModal();
    updateDonationStatus(donationId, newStatus);
}

// Export functions to window for onclick handlers
window.openDonationScreenshotModal = openDonationScreenshotModal;
window.closeDonationScreenshotModal = closeDonationScreenshotModal;
window.updateDonationStatusFromProof = updateDonationStatusFromProof;
window.formatPaymentMethodName = formatPaymentMethodName;

// ===== VOLUNTEER & SERVICE HOUR DETAILS MODALS =====
function openVolunteerDetailsModal(volunteerId) {
    const volunteer = state.volunteers.find(
        (v) => String(v.id) === String(volunteerId),
    );
    if (!volunteer) return;

    const modal = $("volunteer-details-modal");
    if (!modal) return;

    const nameEl = $("vol-modal-name");
    const emailEl = $("vol-modal-email");
    const phoneEl = $("vol-modal-phone");
    const skillsEl = $("vol-modal-skills");
    const availEl = $("vol-modal-avail");
    const docContainer = $("vol-modal-doc-container");
    const notesEl = $("vol-modal-notes");
    const actionsContainer = $("vol-modal-actions");

    if (nameEl)
        nameEl.textContent =
            volunteer.name || volunteer.fullName || "Unnamed Volunteer";
    if (emailEl) emailEl.textContent = volunteer.email || "Not provided";
    if (phoneEl)
        phoneEl.textContent =
            volunteer.phone || volunteer.contactNumber || "Not provided";
    if (skillsEl)
        skillsEl.textContent =
            volunteer.skills || volunteer.experience || "Not specified";
    if (availEl)
        availEl.textContent = volunteer.availability || "Flexible / Not specified";

    if (docContainer) {
        const verification = volunteer.verificationFile;
        const hasDocument = Boolean(verification?.data);
        const fileName = verification?.fileName || "Verification file";
        if (hasDocument) {
            docContainer.innerHTML = `<div class="flex flex-wrap items-center gap-2">
        <button type="button" onclick="window.viewVerificationFile('${escapeHtml(volunteer.id)}')" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-victoria-light text-victoria-blue font-bold text-xs hover:bg-blue-100"><i class="fa-solid fa-file-shield"></i> View Document (${escapeHtml(fileName)})</button>
        <button type="button" onclick="window.downloadVerificationFile('${escapeHtml(volunteer.id)}')" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-50 text-emerald-700 font-bold text-xs hover:bg-emerald-600 hover:text-white"><i class="fa-solid fa-download"></i> Download File</button>
      </div>`;
        } else {
            docContainer.innerHTML = `<span class="text-xs text-slate-400">No document attached</span>`;
        }
    }

    if (notesEl) {
        notesEl.textContent =
            volunteer.notes || volunteer.message || "No additional notes provided.";
    }

    if (actionsContainer) {
        const status = volunteer.status || STATUS.PENDING;
        let btns = "";
        if (status !== STATUS.APPROVED) {
            btns += `<button type="button" onclick="updateVolunteerStatusFromModal('${escapeHtml(volunteer.id)}', '${STATUS.APPROVED}')" class="text-xs font-normal bg-emerald-600 text-white px-3.5 py-2 rounded-md hover:bg-emerald-700 shadow-sm flex items-center gap-1.5"><i class="fa-solid fa-check"></i>Approve</button>`;
        }
        if (status !== STATUS.REJECTED) {
            btns += `<button type="button" onclick="updateVolunteerStatusFromModal('${escapeHtml(volunteer.id)}', '${STATUS.REJECTED}')" class="text-xs font-normal bg-rose-600 text-white px-3.5 py-2 rounded-md hover:bg-rose-700 shadow-sm flex items-center gap-1.5"><i class="fa-solid fa-xmark"></i>Reject</button>`;
        }
        if (status !== STATUS.PENDING) {
            btns += `<button type="button" onclick="updateVolunteerStatusFromModal('${escapeHtml(volunteer.id)}', '${STATUS.PENDING}')" class="text-xs font-normal bg-amber-500 text-white px-3.5 py-2 rounded-md hover:bg-amber-600 shadow-sm flex items-center gap-1.5"><i class="fa-solid fa-rotate"></i>Reset</button>`;
        }
        actionsContainer.innerHTML = btns;
    }

    modal.classList.remove("hidden");
    modal.classList.add("flex");
}

function closeVolunteerDetailsModal() {
    const modal = $("volunteer-details-modal");
    if (modal) {
        modal.classList.add("hidden");
        modal.classList.remove("flex");
    }
}

function updateVolunteerStatusFromModal(volunteerId, newStatus) {
    closeVolunteerDetailsModal();
    updateVolunteerStatus(volunteerId, newStatus);
}

function openServiceHourDetailsModal(recordId) {
    const record = state.serviceHours.find(
        (r) => String(r.id) === String(recordId),
    );
    if (!record) return;

    const modal = $("hour-details-modal");
    if (!modal) return;

    const resEl = $("hour-modal-resident");
    const evEl = $("hour-modal-event");
    const hrEl = $("hour-modal-hours");
    const stEl = $("hour-modal-status-box");
    const actContainer = $("hour-modal-actions");

    if (resEl) resEl.textContent = record.residentName || "Unknown resident";
    if (evEl) evEl.textContent = record.eventTitle || "Unknown event";
    if (hrEl) hrEl.textContent = `${record.hours || 0} Hours`;
    if (stEl) {
        stEl.innerHTML = statusBadge(record.status || STATUS.APPROVED);
    }

    if (actContainer) {
        const status = record.status || STATUS.APPROVED;
        let btns = "";
        if (status !== STATUS.APPROVED) {
            btns += `<button type="button" onclick="updateHourStatusFromModal('${escapeHtml(record.id)}', '${STATUS.APPROVED}')" class="text-xs font-bold bg-emerald-600 text-white px-3.5 py-2 rounded-xl hover:bg-emerald-700 shadow-sm flex items-center gap-1.5"><i class="fa-solid fa-check"></i>Certify Hours</button>`;
        }
        if (status !== STATUS.REJECTED) {
            btns += `<button type="button" onclick="updateHourStatusFromModal('${escapeHtml(record.id)}', '${STATUS.REJECTED}')" class="text-xs font-bold bg-rose-600 text-white px-3.5 py-2 rounded-xl hover:bg-rose-700 shadow-sm flex items-center gap-1.5"><i class="fa-solid fa-xmark"></i>Reject</button>`;
        }
        actContainer.innerHTML = btns;
    }

    modal.classList.remove("hidden");
    modal.classList.add("flex");
}

function closeServiceHourDetailsModal() {
    const modal = $("hour-details-modal");
    if (modal) {
        modal.classList.add("hidden");
        modal.classList.remove("flex");
    }
}

function updateHourStatusFromModal(recordId, newStatus) {
    closeServiceHourDetailsModal();
    // Call status update if needed or showAlert
    showAlert("Notice", "Service hour status updated.");
}

// ==================== ANTI-DEBUGGING & DEVELOPER TOOLS PROTECTION ====================
(function () {
    // Disable right-click context menu
    document.addEventListener("contextmenu", function (e) {
        e.preventDefault();
        return false;
    });

    // Disable keyboard shortcuts for developer tools
    document.addEventListener("keydown", function (e) {
        // F12 key
        if (e.keyCode === 123) {
            e.preventDefault();
            return false;
        }

        // Ctrl+Shift+I (Chrome, Firefox Dev Tools)
        if (e.ctrlKey && e.shiftKey && e.keyCode === 73) {
            e.preventDefault();
            return false;
        }

        // Ctrl+Shift+J (Chrome Console)
        if (e.ctrlKey && e.shiftKey && e.keyCode === 74) {
            e.preventDefault();
            return false;
        }

        // Ctrl+Shift+C (Chrome Element Selector)
        if (e.ctrlKey && e.shiftKey && e.keyCode === 67) {
            e.preventDefault();
            return false;
        }

        // Ctrl+U (View Source)
        if (e.ctrlKey && e.keyCode === 85) {
            e.preventDefault();
            return false;
        }

        // Ctrl+S (Save Page)
        if (e.ctrlKey && e.keyCode === 83) {
            e.preventDefault();
            return false;
        }

        // Ctrl+Shift+K (Firefox Console)
        if (e.ctrlKey && e.shiftKey && e.keyCode === 75) {
            e.preventDefault();
            return false;
        }

        // Ctrl+Shift+E (Firefox Network Tab)
        if (e.ctrlKey && e.shiftKey && e.keyCode === 69) {
            e.preventDefault();
            return false;
        }

        // F5 and Ctrl+R (Refresh - optional, might want to allow refresh)
        // if (e.keyCode === 116 || (e.ctrlKey && e.keyCode === 82)) {
        //     e.preventDefault();
        //     return false;
        // }
    });

    // Detect if Developer Tools is open using various methods
    function detectDevTools() {
        const threshold = 160;
        const widthThreshold = window.outerWidth - window.innerWidth > threshold;
        const heightThreshold = window.outerHeight - window.innerHeight > threshold;

        // Method 1: Window size difference detection
        if (widthThreshold || heightThreshold) {
            handleDevToolsDetected();
        }

        // Method 2: Console.log timing detection
        const startTime = performance.now();
        debugger;
        const endTime = performance.now();

        if (endTime - startTime > 100) {
            handleDevToolsDetected();
        }

        // Method 3: Firefox specific detection
        if (window.devtools && window.devtools.open) {
            handleDevToolsDetected();
        }
    }

    // Method 4: Using requestAnimationFrame to detect console
    let devtoolsOpen = false;
    const element = new Image();
    Object.defineProperty(element, "id", {
        get: function () {
            devtoolsOpen = true;
            handleDevToolsDetected();
        },
    });

    setInterval(function () {
        devtoolsOpen = false;
        console.log("%c", element);
        if (devtoolsOpen) {
            handleDevToolsDetected();
        }
    }, 1000);

    // Method 5: Detect Firebug
    if (window.console && (window.console.firebug || window.console.exception)) {
        handleDevToolsDetected();
    }

    function handleDevToolsDetected() {
        // Clear console
        console.clear();

        // Show warning
        console.log(
            "%c⚠️ WARNING ⚠️",
            "color: red; font-size: 30px; font-weight: bold;",
        );
        console.log(
            "%cDeveloper tools detected!",
            "color: orange; font-size: 20px;",
        );
        console.log(
            "%cThis action has been logged and reported to the administrator.",
            "color: red; font-size: 14px;",
        );
        console.log(
            "%cPlease close developer tools immediately.",
            "color: orange; font-size: 14px;",
        );

        // Optional: Log the attempt
        if (typeof loggedInAdmin !== "undefined" && loggedInAdmin) {
            try {
                // You can add Firestore logging here if needed
                // addDoc(collection(db, 'security_logs'), { ... });
            } catch (e) { }
        }

        // Optional: Show modal warning
        showDevToolsWarning();
    }

    function showDevToolsWarning() {
        // Remove existing warning if any
        const existing = document.getElementById("devtools-warning");
        if (existing) existing.remove();

        const warningModal = document.createElement("div");
        warningModal.id = "devtools-warning";
        warningModal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.9);
            z-index: 999999;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        `;

        warningModal.innerHTML = `
            <div style="
                background: white;
                border-radius: 20px;
                padding: 40px;
                max-width: 500px;
                width: 100%;
                text-align: center;
                box-shadow: 0 25px 50px rgba(0,0,0,0.5);
                animation: fadeInUp 0.3s ease-out;
            ">
                <div style="
                    width: 80px;
                    height: 80px;
                    background: #fee2e2;
                    color: #dc2626;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    margin: 0 auto 20px;
                    font-size: 40px;
                ">
                    <i class="fa-solid fa-triangle-exclamation"></i>
                </div>
                <h2 style="
                    color: #1f2937;
                    font-size: 24px;
                    font-weight: 800;
                    margin-bottom: 10px;
                ">⚠️ Security Warning</h2>
                <p style="
                    color: #6b7280;
                    font-size: 14px;
                    margin-bottom: 10px;
                    line-height: 1.6;
                ">
                    Developer tools have been detected on this page.
                </p>
                <p style="
                    color: #dc2626;
                    font-size: 13px;
                    font-weight: 600;
                    margin-bottom: 20px;
                    background: #fee2e2;
                    padding: 12px;
                    border-radius: 10px;
                ">
                    Using developer tools is strictly prohibited. This action has been logged.
                </p>
                <button onclick="document.getElementById('devtools-warning').remove()" style="
                    background: #2563eb;
                    color: white;
                    border: none;
                    padding: 12px 30px;
                    border-radius: 10px;
                    font-size: 14px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.3s;
                " onmouseover="this.style.background='#1d4ed8'" onmouseout="this.style.background='#2563eb'">
                    <i class="fa-solid fa-check mr-2"></i>I Understand
                </button>
            </div>
        `;

        document.body.appendChild(warningModal);
    }

    // Run detection periodically
    setInterval(detectDevTools, 2000);

    // Prevent dragging of images and links
    document.addEventListener("dragstart", function (e) {
        if (e.target.tagName === "IMG" || e.target.tagName === "A") {
            e.preventDefault();
            return false;
        }
    });

    // Prevent text selection (optional - might affect usability)
    // document.addEventListener('selectstart', function(e) {
    //     e.preventDefault();
    //     return false;
    // });

    // // Disable copy/paste (optional)
    // document.addEventListener('copy', function(e) {
    //     e.preventDefault();
    //     return false;
    // });
    // document.addEventListener('cut', function(e) {
    //     e.preventDefault();
    //     return false;
    // });

    // Override console methods to prevent logging
    const noop = function () { };
    const methods = [
        "log",
        "debug",
        "warn",
        "info",
        "error",
        "exception",
        "table",
        "trace",
    ];

    // Uncomment to completely disable console
    // methods.forEach(function(method) {
    //     console[method] = noop;
    // });

    console.log(
        "%c🔒 Admin Panel Security Active",
        "color: green; font-size: 14px; font-weight: bold;",
    );
})();

window.openVolunteerDetailsModal = openVolunteerDetailsModal;
window.closeVolunteerDetailsModal = closeVolunteerDetailsModal;
window.updateVolunteerStatusFromModal = updateVolunteerStatusFromModal;
window.viewVerificationFile = viewVerificationFile;
window.downloadVerificationFile = downloadVerificationFile;
window.showVolunteerNotes = showVolunteerNotes;
window.openServiceHourDetailsModal = openServiceHourDetailsModal;
window.closeServiceHourDetailsModal = closeServiceHourDetailsModal;
window.updateHourStatusFromModal = updateHourStatusFromModal;