import { useState, useEffect, useRef, useCallback } from "react";
import { X, Bell, BellOff } from "lucide-react";
import { supabase } from "./supabaseClient.js";
import "./styles.css";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * DATA MODEL
 * ─────────────────────────────────────────────────────────────────────────
 * Source of truth: the `machines` table in Supabase Postgres (see
 * supabase/schema.sql). Every connected device subscribes to Postgres
 * Realtime changes on that table — when anyone anywhere updates a row,
 * every other open tab gets pushed the new row over a WebSocket within
 * about a second. There is no polling in this version.
 *
 * Claiming a machine goes through the `claim_machine` Postgres function
 * instead of a plain UPDATE from the browser. That function's WHERE
 * status = 'available' check and the write happen as one atomic operation
 * inside Postgres, so two people tapping "Use machine" on the same
 * machine at nearly the same moment cannot both succeed — the database
 * itself is the referee, not a best-effort recheck in JavaScript.
 *
 * Alert preferences (which machines *this device* wants to be alarmed
 * about) are personal, per-browser settings with no need to be shared —
 * they live in localStorage, which is fine here since this is a normal
 * deployed website, not a sandboxed Claude Artifact.
 * ─────────────────────────────────────────────────────────────────────────
 */

const NOTIFY_PREFS_KEY = "pg-laundry-notify-prefs";
const ALARMED_CYCLES_KEY = "pg-laundry-alarmed-cycles";
const TICK_INTERVAL_MS = 1000;
const ALARM_AUTO_STOP_MS = 45000;
const MAX_ALARMED_CYCLES_REMEMBERED = 30;
const MAX_CUSTOM_MINUTES = 240;

const MACHINE_DEFS = [
    { id: "left", label: "Left Machine" },
    { id: "middle", label: "Middle Machine" },
    { id: "right", label: "Right Machine" },
];
const LABEL_BY_ID = Object.fromEntries(
    MACHINE_DEFS.map((d) => [d.id, d.label]),
);

function readLocal(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
        return fallback;
    }
}
function writeLocal(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
        console.error(`Failed to save ${key}:`, e);
    }
}

/** DB row (snake_case) -> app shape (camelCase). */
function mapRow(row) {
    return {
        id: row.id,
        label: LABEL_BY_ID[row.id] || row.label,
        status: row.status,
        user:
            row.user_name || row.user_room
                ? { name: row.user_name || "", room: row.user_room || "" }
                : null,
        startTime: row.start_time ? new Date(row.start_time).getTime() : null,
        endTime: row.end_time ? new Date(row.end_time).getTime() : null,
        note: row.note || null,
        reportedAt: row.reported_at
            ? new Date(row.reported_at).getTime()
            : null,
    };
}

function cycleKeyFor(machine) {
    return `${machine.id}:${machine.endTime}`;
}

// ── Time formatting helpers ────────────────────────────────────────────

function formatCountdown(ms) {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");
    if (h > 0) return `${h}:${mm}:${ss}`;
    return `${m}:${ss}`;
}
function formatClock(ts) {
    return new Date(ts).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
    });
}
function formatAgo(ms) {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 1) return "just now";
    if (minutes === 1) return "1 minute ago";
    if (minutes < 60) return `${minutes} minutes ago`;
    const hours = Math.floor(minutes / 60);
    const remMin = minutes % 60;
    return `${hours}h ${remMin}m ago`;
}

// ── Alarm engine (sound + vibration + tab-title flash + best-effort push) ─

function useAlarmEngine() {
    const audioCtxRef = useRef(null);
    const beepIntervalRef = useRef(null);
    const autoStopTimeoutRef = useRef(null);
    const titleFlashRef = useRef(null);
    const originalTitleRef = useRef(
        typeof document !== "undefined" ? document.title : "",
    );

    const unlockAudio = useCallback(() => {
        try {
            if (!audioCtxRef.current) {
                const Ctx = window.AudioContext || window.webkitAudioContext;
                if (Ctx) audioCtxRef.current = new Ctx();
            }
            if (
                audioCtxRef.current &&
                audioCtxRef.current.state === "suspended"
            ) {
                audioCtxRef.current.resume();
            }
        } catch (e) {}
    }, []);

    const playBeep = useCallback(() => {
        try {
            const ctx = audioCtxRef.current;
            if (!ctx) return;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = "sine";
            osc.frequency.value = 880;
            gain.gain.setValueAtTime(0.0001, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(
                0.35,
                ctx.currentTime + 0.02,
            );
            gain.gain.exponentialRampToValueAtTime(
                0.0001,
                ctx.currentTime + 0.35,
            );
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 0.4);
        } catch (e) {}
    }, []);

    const stopTitleFlash = useCallback(() => {
        if (titleFlashRef.current) {
            clearInterval(titleFlashRef.current);
            titleFlashRef.current = null;
            document.title = originalTitleRef.current;
        }
    }, []);

    const startTitleFlash = useCallback((label) => {
        if (titleFlashRef.current) return;
        let on = false;
        titleFlashRef.current = setInterval(() => {
            document.title = on
                ? originalTitleRef.current
                : `⏰ ${label} done!`;
            on = !on;
        }, 1000);
    }, []);

    const stopLoop = useCallback(() => {
        if (beepIntervalRef.current) {
            clearInterval(beepIntervalRef.current);
            beepIntervalRef.current = null;
        }
        if (autoStopTimeoutRef.current) {
            clearTimeout(autoStopTimeoutRef.current);
            autoStopTimeoutRef.current = null;
        }
        if (navigator.vibrate) navigator.vibrate(0);
        stopTitleFlash();
    }, [stopTitleFlash]);

    const startLoop = useCallback(
        (label) => {
            unlockAudio();
            stopLoop();
            playBeep();
            if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
            beepIntervalRef.current = setInterval(() => {
                playBeep();
                if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
            }, 900);
            startTitleFlash(label);
            autoStopTimeoutRef.current = setTimeout(
                stopLoop,
                ALARM_AUTO_STOP_MS,
            );
        },
        [playBeep, stopLoop, startTitleFlash, unlockAudio],
    );

    const testBeep = useCallback(() => {
        unlockAudio();
        playBeep();
        if (navigator.vibrate) navigator.vibrate(200);
    }, [unlockAudio, playBeep]);

    const tryPushNotification = useCallback((label) => {
        try {
            if (typeof Notification === "undefined") return;
            if (Notification.permission === "granted") {
                new Notification("Laundry done", {
                    body: `${label} has finished washing.`,
                });
            }
        } catch (e) {}
    }, []);

    const requestPushPermission = useCallback(() => {
        try {
            if (
                typeof Notification !== "undefined" &&
                Notification.permission === "default"
            ) {
                Notification.requestPermission();
            }
        } catch (e) {}
    }, []);

    useEffect(() => stopLoop, [stopLoop]);

    return {
        unlockAudio,
        startLoop,
        stopLoop,
        tryPushNotification,
        requestPushPermission,
        testBeep,
    };
}

// ── Small presentational pieces ────────────────────────────────────────

function StatusPill({ tone, children }) {
    return <span className={`lm-pill lm-pill-${tone}`}>{children}</span>;
}

function MachineCard({
    machine,
    now,
    notifyOn,
    onOpenStart,
    onRemoveClothes,
    onToggleNotify,
    onTestAlarm,
    onOpenCancel,
    onOpenExtend,
    onOpenOutOfOrder,
    onOpenMarkWorking,
}) {
    const { status, label, user, startTime, endTime, note, reportedAt } =
        machine;
    const who =
        user && (user.name || user.room)
            ? [user.name, user.room ? `Room ${user.room}` : null]
                  .filter(Boolean)
                  .join(" · ")
            : null;

    let tone = "available";
    if (status === "washing") tone = "washing";
    if (status === "finished") tone = "finished";
    if (status === "outOfOrder") tone = "outoforder";

    return (
        <div className={`lm-card lm-card-${tone}`}>
            <div className="lm-card-top">
                <span className="lm-card-label">{label}</span>
                <StatusPill tone={tone}>
                    {status === "available" && "Available"}
                    {status === "washing" && "Washing"}
                    {status === "finished" && "Wash complete"}
                    {status === "outOfOrder" && "Out of order"}
                </StatusPill>
            </div>

            {status === "available" && (
                <>
                    <p className="lm-card-sub">Ready to use</p>
                    <button
                        className="lm-btn lm-btn-primary"
                        onClick={() => onOpenStart(machine.id)}
                    >
                        Use machine
                    </button>
                    <button
                        className="lm-btn-link"
                        onClick={() => onOpenOutOfOrder(machine.id)}
                    >
                        Report a problem
                    </button>
                </>
            )}

            {status === "washing" && (
                <>
                    <div className="lm-countdown">
                        {formatCountdown(endTime - now)}
                    </div>
                    <p className="lm-card-sub">remaining</p>
                    <div className="lm-meta">
                        {who && <div className="lm-meta-row">{who}</div>}
                        <div className="lm-meta-row lm-meta-muted">
                            Started {formatClock(startTime)} · Ends{" "}
                            {formatClock(endTime)}
                        </div>
                    </div>
                    <button className="lm-btn lm-btn-disabled" disabled>
                        Currently in use
                    </button>
                    <div className="lm-notify-row">
                        <button
                            className={`lm-btn lm-btn-notify ${notifyOn ? "lm-btn-notify-on" : ""}`}
                            onClick={() => onToggleNotify(machine.id)}
                        >
                            {notifyOn ? (
                                <Bell size={16} />
                            ) : (
                                <BellOff size={16} />
                            )}
                            {notifyOn
                                ? "We'll alert you here when it's done"
                                : "Notify me when done"}
                        </button>
                        {notifyOn && (
                            <button
                                className="lm-btn lm-btn-test"
                                onClick={onTestAlarm}
                                title="Test alarm sound"
                            >
                                🔊
                            </button>
                        )}
                    </div>
                    <div className="lm-secondary-row">
                        <button
                            className="lm-btn-link"
                            onClick={() => onOpenExtend(machine.id)}
                        >
                            Extend time
                        </button>
                        <button
                            className="lm-btn-link lm-btn-link-danger"
                            onClick={() => onOpenCancel(machine.id)}
                        >
                            Cancel wash
                        </button>
                    </div>
                </>
            )}

            {status === "finished" && (
                <>
                    <p className="lm-card-sub">Please collect your clothes</p>
                    <div className="lm-meta">
                        <div className="lm-meta-row lm-meta-muted">
                            Finished {formatAgo(now - endTime)}
                        </div>
                        {who && <div className="lm-meta-row">{who}</div>}
                    </div>
                    <button
                        className="lm-btn lm-btn-finished"
                        onClick={() => onRemoveClothes(machine.id)}
                    >
                        Clothes removed
                    </button>
                    <button
                        className="lm-btn-link"
                        onClick={() => onOpenOutOfOrder(machine.id)}
                    >
                        Report a problem
                    </button>
                </>
            )}

            {status === "outOfOrder" && (
                <>
                    <p className="lm-card-sub">
                        {note ? note : "Needs attention before it can be used"}
                    </p>
                    <div className="lm-meta">
                        {reportedAt && (
                            <div className="lm-meta-row lm-meta-muted">
                                Reported {formatAgo(now - reportedAt)}
                            </div>
                        )}
                    </div>
                    <button
                        className="lm-btn lm-btn-primary"
                        onClick={() => onOpenMarkWorking(machine.id)}
                    >
                        Mark as working again
                    </button>
                </>
            )}
        </div>
    );
}

const DURATION_PRESETS = [30, 45, 60, 90];

function StartWashModal({ machine, onCancel, onConfirm, submitting }) {
    const [selectedPreset, setSelectedPreset] = useState(30);
    const [useCustom, setUseCustom] = useState(false);
    const [customMinutes, setCustomMinutes] = useState("");
    const [name, setName] = useState("");
    const [room, setRoom] = useState("");
    const [error, setError] = useState("");

    const effectiveMinutes = useCustom
        ? parseInt(customMinutes, 10)
        : selectedPreset;
    const isValid =
        Number.isFinite(effectiveMinutes) &&
        effectiveMinutes > 0 &&
        effectiveMinutes <= MAX_CUSTOM_MINUTES;

    const handleStart = () => {
        if (!Number.isFinite(effectiveMinutes) || effectiveMinutes <= 0) {
            setError("Enter a duration greater than 0 minutes.");
            return;
        }
        if (effectiveMinutes > MAX_CUSTOM_MINUTES) {
            setError(`Keep it under ${MAX_CUSTOM_MINUTES} minutes.`);
            return;
        }
        onConfirm({
            minutes: effectiveMinutes,
            name: name.trim(),
            room: room.trim(),
        });
    };

    return (
        <div className="lm-sheet-backdrop" onClick={onCancel}>
            <div className="lm-sheet" onClick={(e) => e.stopPropagation()}>
                <div className="lm-sheet-handle" />
                <div className="lm-sheet-header">
                    <h2>{machine.label}</h2>
                    <button
                        className="lm-icon-btn"
                        onClick={onCancel}
                        aria-label="Close"
                    >
                        <X size={20} />
                    </button>
                </div>

                <p className="lm-sheet-label">Washing duration</p>
                <div className="lm-preset-row">
                    {DURATION_PRESETS.map((mins) => (
                        <button
                            key={mins}
                            className={`lm-preset-btn ${!useCustom && selectedPreset === mins ? "lm-preset-active" : ""}`}
                            onClick={() => {
                                setUseCustom(false);
                                setSelectedPreset(mins);
                                setError("");
                            }}
                        >
                            {mins}m
                        </button>
                    ))}
                    <button
                        className={`lm-preset-btn ${useCustom ? "lm-preset-active" : ""}`}
                        onClick={() => {
                            setUseCustom(true);
                            setError("");
                        }}
                    >
                        Custom
                    </button>
                </div>

                {useCustom && (
                    <>
                        <input
                            className="lm-input"
                            type="number"
                            inputMode="numeric"
                            min="1"
                            max={MAX_CUSTOM_MINUTES}
                            placeholder="Minutes"
                            value={customMinutes}
                            onChange={(e) => {
                                setCustomMinutes(e.target.value);
                                setError("");
                            }}
                            autoFocus
                        />
                        <p className="lm-sheet-hint" style={{ marginTop: 6 }}>
                            Up to {MAX_CUSTOM_MINUTES} minutes.
                        </p>
                    </>
                )}

                <p className="lm-sheet-label lm-sheet-label-spaced">
                    Who's using this machine? (optional)
                </p>
                <input
                    className="lm-input"
                    type="text"
                    placeholder="Name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                />
                <input
                    className="lm-input"
                    type="text"
                    inputMode="numeric"
                    placeholder="Room number"
                    value={room}
                    onChange={(e) => setRoom(e.target.value)}
                />

                <p className="lm-sheet-hint">
                    🔔 We'll sound an alarm on this device when it's done.
                </p>

                {error && <p className="lm-error">{error}</p>}

                <div className="lm-sheet-actions">
                    <button className="lm-btn lm-btn-ghost" onClick={onCancel}>
                        Cancel
                    </button>
                    <button
                        className="lm-btn lm-btn-primary"
                        onClick={handleStart}
                        disabled={!isValid || submitting}
                    >
                        {submitting ? "Starting…" : "Start washing"}
                    </button>
                </div>
            </div>
        </div>
    );
}

const EXTEND_PRESETS = [10, 15, 30];

function ExtendModal({ machine, onCancel, onConfirm }) {
    return (
        <div className="lm-sheet-backdrop" onClick={onCancel}>
            <div className="lm-sheet" onClick={(e) => e.stopPropagation()}>
                <div className="lm-sheet-handle" />
                <div className="lm-sheet-header">
                    <h2>Extend {machine.label}</h2>
                    <button
                        className="lm-icon-btn"
                        onClick={onCancel}
                        aria-label="Close"
                    >
                        <X size={20} />
                    </button>
                </div>
                <p className="lm-sheet-label">Add time to the current wash</p>
                <div
                    className="lm-preset-row"
                    style={{ gridTemplateColumns: "repeat(3, 1fr)" }}
                >
                    {EXTEND_PRESETS.map((mins) => (
                        <button
                            key={mins}
                            className="lm-preset-btn"
                            onClick={() => onConfirm(mins)}
                        >
                            +{mins}m
                        </button>
                    ))}
                </div>
                <p className="lm-sheet-hint">
                    New finish time updates for everyone within a second or two.
                </p>
                <div className="lm-sheet-actions">
                    <button className="lm-btn lm-btn-ghost" onClick={onCancel}>
                        Never mind
                    </button>
                </div>
            </div>
        </div>
    );
}

function OutOfOrderModal({ machine, onCancel, onConfirm }) {
    const [note, setNote] = useState("");
    return (
        <div className="lm-sheet-backdrop" onClick={onCancel}>
            <div className="lm-sheet" onClick={(e) => e.stopPropagation()}>
                <div className="lm-sheet-handle" />
                <div className="lm-sheet-header">
                    <h2>Report {machine.label}</h2>
                    <button
                        className="lm-icon-btn"
                        onClick={onCancel}
                        aria-label="Close"
                    >
                        <X size={20} />
                    </button>
                </div>
                <p className="lm-sheet-label">What's wrong? (optional)</p>
                <input
                    className="lm-input"
                    type="text"
                    placeholder="e.g. leaking, won't drain, door stuck"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    autoFocus
                />
                <p className="lm-sheet-hint">
                    This marks the machine unavailable for everyone until
                    someone sets it back to working.
                </p>
                <div className="lm-sheet-actions">
                    <button className="lm-btn lm-btn-ghost" onClick={onCancel}>
                        Cancel
                    </button>
                    <button
                        className="lm-btn lm-btn-primary"
                        onClick={() => onConfirm(note.trim())}
                    >
                        Mark out of order
                    </button>
                </div>
            </div>
        </div>
    );
}

function ConfirmModal({
    title,
    message,
    confirmLabel,
    danger,
    onCancel,
    onConfirm,
}) {
    return (
        <div className="lm-alarm-backdrop" onClick={onCancel}>
            <div className="lm-alarm-card" onClick={(e) => e.stopPropagation()}>
                <h2>{title}</h2>
                <p>{message}</p>
                <div className="lm-sheet-actions">
                    <button className="lm-btn lm-btn-ghost" onClick={onCancel}>
                        Never mind
                    </button>
                    <button
                        className={`lm-btn ${danger ? "lm-btn-danger" : "lm-btn-primary"}`}
                        onClick={onConfirm}
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}

function AlarmOverlay({ item, onDismiss }) {
    if (!item) return null;
    return (
        <div className="lm-alarm-backdrop">
            <div className="lm-alarm-card">
                <div className="lm-alarm-icon">⏰</div>
                <h2>{item.label} is done!</h2>
                <p>
                    Time to grab your clothes before someone else needs the
                    machine.
                </p>
                <button className="lm-btn lm-btn-primary" onClick={onDismiss}>
                    Got it, stop alarm
                </button>
            </div>
        </div>
    );
}

function UndoToast({ toast, onUndo }) {
    if (!toast) return null;
    return (
        <div className="lm-toast">
            <span>{toast.message}</span>
            <button onClick={onUndo}>Undo</button>
        </div>
    );
}

// ── Root component ─────────────────────────────────────────────────────

export default function App() {
    const [machines, setMachines] = useState(null);
    const [notifyPrefs, setNotifyPrefs] = useState(() =>
        readLocal(NOTIFY_PREFS_KEY, {}),
    );
    const [now, setNow] = useState(Date.now());
    const [modalMachineId, setModalMachineId] = useState(null);
    const [extendMachineId, setExtendMachineId] = useState(null);
    const [outOfOrderMachineId, setOutOfOrderMachineId] = useState(null);
    const [confirmDialog, setConfirmDialog] = useState(null);
    const [claimError, setClaimError] = useState("");
    const [claimSubmitting, setClaimSubmitting] = useState(false);
    const [alarmQueue, setAlarmQueue] = useState([]);
    const [undoToast, setUndoToast] = useState(null);
    const [connectionStatus, setConnectionStatus] = useState("connecting"); // 'connecting' | 'live' | 'reconnecting'

    const machinesRef = useRef(null);
    const finishingMachineIdsRef = useRef(new Set());
    const undoTimeoutRef = useRef(null);
    const notifyPrefsRef = useRef(notifyPrefs);
    const alarmedCyclesRef = useRef(readLocal(ALARMED_CYCLES_KEY, []));
    machinesRef.current = machines;

    const alarm = useAlarmEngine();

    const markAlarmed = useCallback((key) => {
        const next = [...alarmedCyclesRef.current, key].slice(
            -MAX_ALARMED_CYCLES_REMEMBERED,
        );
        alarmedCyclesRef.current = next;
        writeLocal(ALARMED_CYCLES_KEY, next);
    }, []);

    // Adopts an incoming machines object (from initial fetch or a realtime
    // event), diffing against what we had locally to detect washing->finished
    // transitions worth alarming about. This never writes back to Supabase —
    // it only reacts to what the database has already told us.
    const applyIncoming = useCallback(
        (next) => {
            const prev = machinesRef.current;
            if (prev) {
                for (const id of Object.keys(next)) {
                    const wasWashing =
                        prev[id] && prev[id].status === "washing";
                    const isFinishedNow =
                        next[id] && next[id].status === "finished";
                    if (
                        wasWashing &&
                        isFinishedNow &&
                        notifyPrefsRef.current[id]
                    ) {
                        const key = cycleKeyFor(next[id]);
                        if (!alarmedCyclesRef.current.includes(key)) {
                            markAlarmed(key);
                            setAlarmQueue((q) => [
                                ...q,
                                { id, label: LABEL_BY_ID[id], cycleKey: key },
                            ]);
                        }
                    }
                }
            }
            machinesRef.current = next;
            setMachines(next);
        },
        [markAlarmed],
    );

    // Initial fetch + realtime subscription. This replaces the polling loop
    // from the Artifact prototype: Supabase pushes changed rows over a
    // WebSocket, so every connected phone updates within about a second of
    // any change, instead of waiting for the next poll.
    useEffect(() => {
        let cancelled = false;

        (async () => {
            const { data, error } = await supabase.from("machines").select("*");
            if (cancelled) return;
            if (error) {
                console.error("Failed to load machines:", error);
                return;
            }
            const byId = {};
            for (const row of data) byId[row.id] = mapRow(row);
            applyIncoming(byId);
        })();

        const channel = supabase
            .channel("machines-realtime")
            .on(
                "postgres_changes",
                { event: "*", schema: "public", table: "machines" },
                (payload) => {
                    const row = payload.new;
                    if (!row || !row.id) return;
                    const current = machinesRef.current || {};
                    applyIncoming({ ...current, [row.id]: mapRow(row) });
                },
            )
            .subscribe((status) => {
                if (status === "SUBSCRIBED") setConnectionStatus("live");
                else if (
                    status === "CLOSED" ||
                    status === "CHANNEL_ERROR" ||
                    status === "TIMED_OUT"
                ) {
                    setConnectionStatus("reconnecting");
                }
            });

        return () => {
            cancelled = true;
            supabase.removeChannel(channel);
        };
    }, [applyIncoming]);

    // 1s tick — drives the visible countdown, and locally detects when a
    // wash's endTime has passed so this device can flip it to 'finished' in
    // the database. The `.eq("status", "washing")` guard makes this safe to
    // race across multiple devices: whichever client's write lands first
    // wins, and everyone else's identical write just matches zero rows.
    useEffect(() => {
        const tick = setInterval(() => {
            const ts = Date.now();
            setNow(ts);
            const current = machinesRef.current;
            if (!current) return;
            for (const id of Object.keys(current)) {
                const m = current[id];
                if (
                    m.status === "washing" &&
                    m.endTime !== null &&
                    ts >= m.endTime &&
                    !finishingMachineIdsRef.current.has(id)
                ) {
                    finishingMachineIdsRef.current.add(id);
                    applyIncoming({
                        ...machinesRef.current,
                        [id]: { ...m, status: "finished" },
                    });

                    supabase
                        .from("machines")
                        .update({ status: "finished" })
                        .eq("id", id)
                        .eq("status", "washing")
                        .select("*")
                        .maybeSingle()
                        .then(({ data, error }) => {
                            if (error || !data) {
                                const currentMachine =
                                    machinesRef.current?.[id];
                                if (
                                    currentMachine?.status === "finished" &&
                                    currentMachine.endTime === m.endTime
                                ) {
                                    applyIncoming({
                                        ...machinesRef.current,
                                        [id]: m,
                                    });
                                }
                            }
                            finishingMachineIdsRef.current.delete(id);
                        });
                }
            }
        }, TICK_INTERVAL_MS);
        return () => clearInterval(tick);
    }, []);

    // Drive the alarm engine off the queue.
    const topCycleKey = alarmQueue[0]?.cycleKey;
    useEffect(() => {
        if (alarmQueue.length === 0) {
            alarm.stopLoop();
            return;
        }
        const top = alarmQueue[0];
        alarm.startLoop(top.label);
        alarm.tryPushNotification(top.label);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [topCycleKey]);

    const dismissAlarm = () => {
        alarm.stopLoop();
        setAlarmQueue((q) => q.slice(1));
    };

    const handleToggleNotify = (machineId) => {
        alarm.unlockAudio();
        alarm.requestPushPermission();
        const next = {
            ...notifyPrefsRef.current,
            [machineId]: !notifyPrefsRef.current[machineId],
        };
        notifyPrefsRef.current = next;
        setNotifyPrefs(next);
        writeLocal(NOTIFY_PREFS_KEY, next);
    };

    const handleOpenStart = (machineId) => {
        alarm.unlockAudio();
        setClaimError("");
        setModalMachineId(machineId);
    };

    const handleConfirmStart = async ({ minutes, name, room }) => {
        alarm.requestPushPermission();
        setClaimSubmitting(true);
        const { data, error } = await supabase.rpc("claim_machine", {
            p_id: modalMachineId,
            p_name: name,
            p_room: room,
            p_minutes: minutes,
        });
        setClaimSubmitting(false);

        if (error || !data || data.length === 0) {
            setClaimError(
                "Someone just claimed this machine. Pick another one.",
            );
            setModalMachineId(null);
            return;
        }

        const nextPrefs = { ...notifyPrefsRef.current, [modalMachineId]: true };
        notifyPrefsRef.current = nextPrefs;
        setNotifyPrefs(nextPrefs);
        writeLocal(NOTIFY_PREFS_KEY, nextPrefs);

        // applyIncoming will also run when the realtime event for this row
        // arrives, but updating immediately keeps this device's own UI snappy
        // rather than waiting on the round trip.
        applyIncoming({
            ...machinesRef.current,
            [modalMachineId]: mapRow(data[0]),
        });
        setModalMachineId(null);
    };

    const setMachineAvailableWithUndo = async (machineId, undoMessage) => {
        const snapshot = machinesRef.current[machineId];
        await supabase
            .from("machines")
            .update({
                status: "available",
                user_name: null,
                user_room: null,
                start_time: null,
                end_time: null,
                note: null,
                reported_at: null,
            })
            .eq("id", machineId);

        if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
        setUndoToast({ message: undoMessage, machineId, snapshot });
        undoTimeoutRef.current = setTimeout(() => setUndoToast(null), 6000);
    };

    const handleRemoveClothes = (machineId) =>
        setMachineAvailableWithUndo(
            machineId,
            `${LABEL_BY_ID[machineId]} marked available.`,
        );

    const handleUndoRemoveClothes = async () => {
        if (!undoToast) return;
        const s = undoToast.snapshot;
        await supabase
            .from("machines")
            .update({
                status: s.status,
                user_name: s.user?.name || null,
                user_room: s.user?.room || null,
                start_time: s.startTime
                    ? new Date(s.startTime).toISOString()
                    : null,
                end_time: s.endTime ? new Date(s.endTime).toISOString() : null,
                note: s.note,
                reported_at: s.reportedAt
                    ? new Date(s.reportedAt).toISOString()
                    : null,
            })
            .eq("id", undoToast.machineId);
        if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
        setUndoToast(null);
    };

    const handleTestAlarm = () => alarm.testBeep();

    const handleOpenCancel = (machineId) =>
        setConfirmDialog({ type: "cancelWash", machineId });
    const handleOpenMarkWorking = (machineId) =>
        setConfirmDialog({ type: "markWorking", machineId });

    const handleConfirmDialogAccept = () => {
        if (!confirmDialog) return;
        const { type, machineId } = confirmDialog;
        if (type === "cancelWash")
            setMachineAvailableWithUndo(
                machineId,
                `${LABEL_BY_ID[machineId]} wash cancelled.`,
            );
        else if (type === "markWorking")
            setMachineAvailableWithUndo(
                machineId,
                `${LABEL_BY_ID[machineId]} marked available.`,
            );
        setConfirmDialog(null);
    };

    const handleOpenExtend = (machineId) => setExtendMachineId(machineId);

    const handleConfirmExtend = async (minutes) => {
        const target = machinesRef.current[extendMachineId];
        if (!target || target.status !== "washing") {
            setExtendMachineId(null);
            return;
        }
        const newEndTime = new Date(
            target.endTime + minutes * 60 * 1000,
        ).toISOString();
        await supabase
            .from("machines")
            .update({ end_time: newEndTime })
            .eq("id", extendMachineId)
            .eq("status", "washing");
        setExtendMachineId(null);
    };

    const handleOpenOutOfOrder = (machineId) =>
        setOutOfOrderMachineId(machineId);

    const handleConfirmOutOfOrder = async (note) => {
        await supabase
            .from("machines")
            .update({
                status: "outOfOrder",
                user_name: null,
                user_room: null,
                start_time: null,
                end_time: null,
                note: note || null,
                reported_at: new Date().toISOString(),
            })
            .eq("id", outOfOrderMachineId);
        setOutOfOrderMachineId(null);
    };

    useEffect(() => {
        return () => {
            if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
        };
    }, []);

    const modalMachine = modalMachineId ? machines?.[modalMachineId] : null;
    const extendMachine = extendMachineId ? machines?.[extendMachineId] : null;
    const outOfOrderMachine = outOfOrderMachineId
        ? machines?.[outOfOrderMachineId]
        : null;
    const connectionLabel =
        connectionStatus === "live"
            ? "Live"
            : connectionStatus === "reconnecting"
              ? "Reconnecting…"
              : "Connecting…";

    return (
        <div className="lm-root">
            <header className="lm-header">
                <div>
                    <h1>🧺 Laundry Status</h1>
                    <p>PG Washing Area</p>
                </div>
                <div>
                    <div className="lm-clock">{formatClock(now)}</div>
                    <div
                        className={`lm-sync ${connectionStatus === "live" ? "lm-sync-live" : ""}`}
                    >
                        {connectionLabel}
                    </div>
                </div>
            </header>

            {claimError && <div className="lm-banner">{claimError}</div>}

            <main className="lm-list">
                {!machines &&
                    MACHINE_DEFS.map((def) => (
                        <div className="lm-card lm-card-loading" key={def.id}>
                            <div
                                className="lm-skeleton-line"
                                style={{ width: "50%" }}
                            />
                            <div
                                className="lm-skeleton-line"
                                style={{ width: "30%" }}
                            />
                        </div>
                    ))}
                {machines &&
                    MACHINE_DEFS.map((def) => (
                        <MachineCard
                            key={def.id}
                            machine={machines[def.id]}
                            now={now}
                            notifyOn={!!notifyPrefs[def.id]}
                            onOpenStart={handleOpenStart}
                            onRemoveClothes={handleRemoveClothes}
                            onToggleNotify={handleToggleNotify}
                            onTestAlarm={handleTestAlarm}
                            onOpenCancel={handleOpenCancel}
                            onOpenExtend={handleOpenExtend}
                            onOpenOutOfOrder={handleOpenOutOfOrder}
                            onOpenMarkWorking={handleOpenMarkWorking}
                        />
                    ))}
            </main>

            <UndoToast toast={undoToast} onUndo={handleUndoRemoveClothes} />

            <p className="lm-demo-note">
                Updates sync live to everyone using this page.
            </p>

            {modalMachine && (
                <StartWashModal
                    machine={modalMachine}
                    submitting={claimSubmitting}
                    onCancel={() => setModalMachineId(null)}
                    onConfirm={handleConfirmStart}
                />
            )}

            {extendMachine && (
                <ExtendModal
                    machine={extendMachine}
                    onCancel={() => setExtendMachineId(null)}
                    onConfirm={handleConfirmExtend}
                />
            )}

            {outOfOrderMachine && (
                <OutOfOrderModal
                    machine={outOfOrderMachine}
                    onCancel={() => setOutOfOrderMachineId(null)}
                    onConfirm={handleConfirmOutOfOrder}
                />
            )}

            {confirmDialog?.type === "cancelWash" && (
                <ConfirmModal
                    title="Cancel this wash?"
                    message={`${LABEL_BY_ID[confirmDialog.machineId]} will be marked available for someone else right away.`}
                    confirmLabel="Cancel wash"
                    danger
                    onCancel={() => setConfirmDialog(null)}
                    onConfirm={handleConfirmDialogAccept}
                />
            )}

            {confirmDialog?.type === "markWorking" && (
                <ConfirmModal
                    title="Mark as working again?"
                    message={`${LABEL_BY_ID[confirmDialog.machineId]} will show as available to everyone.`}
                    confirmLabel="Mark available"
                    onCancel={() => setConfirmDialog(null)}
                    onConfirm={handleConfirmDialogAccept}
                />
            )}

            <AlarmOverlay item={alarmQueue[0]} onDismiss={dismissAlarm} />
        </div>
    );
}
