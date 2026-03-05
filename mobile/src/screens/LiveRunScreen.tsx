import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Location from 'expo-location';
import * as Speech from 'expo-speech';
import * as TaskManager from 'expo-task-manager';
import { setAudioModeAsync } from 'expo-audio';
import * as Notifications from 'expo-notifications';
import MapView, { Marker, Polyline } from 'react-native-maps';
import {
  clearActiveSession,
  checkinSession,
  enqueueAction,
  flushSyncQueue,
  getPendingSyncCount,
  getPlanToday,
  loadActiveSession,
  saveActiveSession,
  sessionEvent,
  startSession,
  stopSession,
} from '../lib/api';

type CheckStage = 'none' | 'effort' | 'fatigue' | 'pain_type' | 'pain_location' | 'done';

type Coord = { latitude: number; longitude: number; ts: number; accuracy?: number; speed?: number | null };

const BG_TASK_NAME = 'motioncoachlab-bg-location';
let BG_POINTS: Coord[] = [];

if (!TaskManager.isTaskDefined(BG_TASK_NAME)) {
  TaskManager.defineTask(BG_TASK_NAME, async ({ data, error }) => {
    if (error) return;
    const locations = (data as any)?.locations || [];
    for (const l of locations) {
      BG_POINTS.push({
        latitude: l.coords.latitude,
        longitude: l.coords.longitude,
        ts: Date.now(),
      });
    }
  });
}

export default function LiveRunScreen({
  userId,
  cueDetailMode,
  onCueDetailModeChange,
}: {
  userId: number;
  cueDetailMode: boolean;
  onCueDetailModeChange: (value: boolean) => void;
}) {
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [distanceM, setDistanceM] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [backgroundMode, setBackgroundMode] = useState(true);
  const [guidedCuesEnabled, setGuidedCuesEnabled] = useState(true);
  const [msg, setMsg] = useState('');
  const [checkStage, setCheckStage] = useState<CheckStage>('none');
  const [check, setCheck] = useState({ effort: '', fatigue: '', pain_type: '', pain_location: '' });
  const [routeCoords, setRouteCoords] = useState<Coord[]>([]);
  const [intervalPlan, setIntervalPlan] = useState<{ warmup: number; run: number; walk: number; repeats: number; cooldown: number } | null>(null);
  const [diag, setDiag] = useState<string[]>([]);
  const [syncState, setSyncState] = useState<'synced' | 'syncing' | 'pending'>('synced');
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [voiceOptions, setVoiceOptions] = useState<Array<{ id: string; name: string; language?: string }>>([]);
  const [voiceIdx, setVoiceIdx] = useState(0);

  const watcherRef = useRef<Location.LocationSubscription | null>(null);
  const pointsRef = useRef<Coord[]>([]);
  const cueTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const cuePlanRef = useRef<Array<{ atSec: number; text: string; type: string }>>([]);
  const cueCursorRef = useRef(0);
  const cueSessionIdRef = useRef<number | null>(null);
  const cueNotificationIdsRef = useRef<string[]>([]);
  const pauseAccumRef = useRef<number>(0);
  const pauseStartedAtRef = useRef<number | null>(null);
  const lastPointTsRef = useRef<number | null>(null);
  const stalledWarnedRef = useRef(false);
  const isSpeakingRef = useRef(false);
  const queuedSpeechRef = useRef<{ text: string; cueType: string } | null>(null);
  const speechWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appStateRef = useRef(AppState.currentState);
  const speechAudioModeRef = useRef(false);

  useEffect(() => {
    const loadPlan = async () => {
      try {
        const today = await getPlanToday(userId);
        const interval = today.interval as any;
        if (interval && interval.run && interval.repeats) {
          setIntervalPlan({
            warmup: Number(interval.warmup || 5),
            run: Number(interval.run || 1),
            walk: Number(interval.walk || 1),
            repeats: Number(interval.repeats || 6),
            cooldown: Number(interval.cooldown || 5),
          });
        } else {
          setIntervalPlan(null);
        }
      } catch {
        setIntervalPlan(null);
      }
    };
    loadPlan();
  }, [userId]);

  useEffect(() => {
    const loadVoices = async () => {
      try {
        const voices = await Speech.getAvailableVoicesAsync();
        const english = voices
          .filter((v: any) => String(v.language || '').toLowerCase().startsWith('en'))
          .map((v: any) => ({ id: String(v.identifier), name: String(v.name || v.identifier), language: String(v.language || '') }))
          .filter((v: any) => !String(v.id).toLowerCase().includes('siri'));
        if (english.length) setVoiceOptions(english);
      } catch {
        // Keep default voice when unavailable.
      }
    };
    loadVoices();
  }, []);

  useEffect(() => {
    const configureAudio = async () => {
      try {
        await setAudioModeAsync({
          playsInSilentMode: true,
          shouldPlayInBackground: true,
          interruptionMode: 'mixWithOthers',
          interruptionModeAndroid: 'duckOthers',
          shouldRouteThroughEarpiece: false,
        });
      } catch {
        // Leave default audio behavior when mode configuration fails.
      }
    };
    configureAudio();
  }, []);

  useEffect(() => {
    const setupNotifications = async () => {
      try {
        await Notifications.requestPermissionsAsync();
        await Notifications.setNotificationHandler({
          handleNotification: async () => {
            const isActive = appStateRef.current === 'active';
            return {
              shouldShowBanner: !isActive,
              shouldShowList: true,
              shouldPlaySound: !isActive,
              shouldSetBadge: false,
            };
          },
        });
      } catch {
        // Continue without lock-screen cue notifications.
      }
    };
    setupNotifications();
    const sub = AppState.addEventListener('change', (state) => {
      appStateRef.current = state;
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!startedAt || isPaused) return;
    const id = setInterval(() => {
      const paused = pauseAccumRef.current;
      const elapsedSec = Math.max(0, Math.floor((Date.now() - startedAt - paused) / 1000));
      setSeconds(elapsedSec);
      processDueCues(elapsedSec);
    }, 1000);
    return () => clearInterval(id);
  }, [startedAt, isPaused]);

  useEffect(() => {
    return () => {
      watcherRef.current?.remove();
      clearCueTimers();
      cancelCueNotifications().catch(() => null);
      stopBackgroundUpdates();
      Speech.stop();
    };
  }, []);

  useEffect(() => {
    const boot = async () => {
      const recovered = await loadActiveSession(userId);
      if (recovered) {
        setSessionId(recovered.sessionId);
        setStartedAt(recovered.startedAt);
        setSeconds(recovered.seconds || 0);
        setDistanceM(recovered.distanceM || 0);
        setIsPaused(!!recovered.isPaused);
        setBackgroundMode(!!recovered.backgroundMode);
        pauseAccumRef.current = Number(recovered.pauseAccumMs || 0);
        pointsRef.current = recovered.points || [];
        setRouteCoords(recovered.points || []);
        logDiag(`recovered session ${recovered.sessionId}`);
        if (!recovered.isPaused) {
          await startWatcher();
          await startBackgroundUpdates();
        }
      }
      await refreshSyncStatus();
    };
    boot();
  }, [userId]);

  useEffect(() => {
    if (!startedAt || !sessionId) return;
    const id = setInterval(() => {
      persistActive().catch(() => null);
    }, 15000);
    return () => clearInterval(id);
  }, [startedAt, sessionId, seconds, distanceM, isPaused, backgroundMode, routeCoords.length]);

  useEffect(() => {
    if (!startedAt || isPaused) return;
    const id = setInterval(() => {
      if (!lastPointTsRef.current) return;
      const gapMs = Date.now() - lastPointTsRef.current;
      if (gapMs > 20000 && !stalledWarnedRef.current) {
        stalledWarnedRef.current = true;
        setMsg('GPS signal paused. Keep app open and location on; tracking will resume automatically.');
        logDiag('gps stalled >20s');
      }
    }, 5000);
    return () => clearInterval(id);
  }, [startedAt, isPaused]);

  const elapsed = useMemo(() => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`, [seconds]);
  const distanceLabel = useMemo(() => (distanceM < 1000 ? `${Math.round(distanceM)} m` : `${(distanceM / 1000).toFixed(2)} km`), [distanceM]);
  const pace = useMemo(() => {
    if (distanceM <= 0 || seconds <= 0) return '-';
    const min = seconds / 60;
    const km = distanceM / 1000;
    return `${(min / km).toFixed(2)} min/km`;
  }, [distanceM, seconds]);

  const requestLocation = async (): Promise<boolean> => {
    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') {
      setMsg('Location permission required to track distance.');
      return false;
    }
    return true;
  };

  const startBackgroundUpdates = async () => {
    if (!backgroundMode) return;
    const bg = await Location.requestBackgroundPermissionsAsync();
    if (bg.status !== 'granted') {
      setMsg('Background location not granted. Continuing in foreground mode.');
      return;
    }
    const started = await Location.hasStartedLocationUpdatesAsync(BG_TASK_NAME);
    if (!started) {
      await Location.startLocationUpdatesAsync(BG_TASK_NAME, {
        accuracy: Location.Accuracy.Balanced,
        timeInterval: 5000,
        distanceInterval: 10,
        pausesUpdatesAutomatically: false,
        foregroundService: {
          notificationTitle: 'MotionCoachLab run in progress',
          notificationBody: 'Tracking your run in background.',
        },
      });
    }
  };

  const stopBackgroundUpdates = async () => {
    try {
      const started = await Location.hasStartedLocationUpdatesAsync(BG_TASK_NAME);
      if (started) await Location.stopLocationUpdatesAsync(BG_TASK_NAME);
    } catch {
      // ignore cleanup errors
    }
  };

  const startWatcher = async () => {
    watcherRef.current?.remove();
    watcherRef.current = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 2000,
        distanceInterval: 3,
      },
      (loc) => {
        if (isPaused) return;
        const p: Coord = {
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
          ts: Date.now(),
          accuracy: loc.coords.accuracy ?? undefined,
          speed: loc.coords.speed ?? undefined,
        };
        const prev = pointsRef.current[pointsRef.current.length - 1];
        pointsRef.current.push(p);
        lastPointTsRef.current = p.ts;
        if (stalledWarnedRef.current) {
          stalledWarnedRef.current = false;
          setMsg('GPS signal restored.');
          logDiag('gps restored');
        }
        setRouteCoords([...pointsRef.current]);
        if (prev) {
          const delta = segmentMeters(prev, p);
          if (delta > 0) {
            setDistanceM((d) => d + delta);
          }
        }
        if (startedAt && !isPaused) {
          const paused = pauseAccumRef.current;
          const elapsedSec = Math.max(0, Math.floor((Date.now() - startedAt - paused) / 1000));
          processDueCues(elapsedSec);
        }
      }
    );
  };

  const speak = (text: string, cueType = 'cue') => {
    if (appStateRef.current !== 'active') {
      logDiag(`tts skipped in ${appStateRef.current} (${cueType})`);
      return;
    }
    if (isSpeakingRef.current) {
      queuedSpeechRef.current = { text, cueType };
      logDiag(`tts queued ${cueType}`);
      return;
    }
    const selected = voiceOptions[voiceIdx];
    isSpeakingRef.current = true;
    const setSpeechAudioMode = async (enabled: boolean) => {
      if (speechAudioModeRef.current === enabled) return;
      try {
        await setAudioModeAsync({
          playsInSilentMode: true,
          shouldPlayInBackground: true,
          interruptionMode: enabled ? 'duckOthers' : 'mixWithOthers',
          interruptionModeAndroid: 'duckOthers',
          shouldRouteThroughEarpiece: false,
        });
        speechAudioModeRef.current = enabled;
      } catch {
        // Keep prior mode if this fails.
      }
    };
    const drainQueue = () => {
      if (speechWatchdogRef.current) {
        clearTimeout(speechWatchdogRef.current);
        speechWatchdogRef.current = null;
      }
      isSpeakingRef.current = false;
      const queued = queuedSpeechRef.current;
      queuedSpeechRef.current = null;
      if (queued) {
        setTimeout(() => speak(queued.text, queued.cueType), 120);
      } else {
        setSpeechAudioMode(false).catch(() => null);
      }
    };

    speechWatchdogRef.current = setTimeout(() => {
      logDiag(`tts watchdog release ${cueType}`);
      drainQueue();
    }, 8000);

    setSpeechAudioMode(true).catch(() => null);
    Speech.speak(text, {
      rate: 0.95,
      pitch: 1.0,
      voice: selected?.id,
      language: selected?.language || 'en-AU',
      onStart: () => logDiag(`tts start ${cueType}`),
      onDone: () => {
        logDiag(`tts done ${cueType}`);
        drainQueue();
      },
      onStopped: () => {
        logDiag(`tts stopped ${cueType}`);
        drainQueue();
      },
      onError: () => {
        logDiag(`tts error ${cueType}`);
        drainQueue();
      },
    });
  };

  const logDiag = (line: string) => {
    const ts = new Date().toLocaleTimeString();
    setDiag((d) => [`${ts} ${line}`, ...d].slice(0, 10));
  };

  const refreshSyncStatus = async () => {
    const pending = await getPendingSyncCount();
    setPendingSyncCount(pending);
    setSyncState(pending > 0 ? 'pending' : 'synced');
  };

  const persistActive = async () => {
    if (!sessionId || !startedAt) return;
    await saveActiveSession({
      userId,
      sessionId,
      startedAt,
      seconds,
      distanceM,
      isPaused,
      pauseAccumMs: pauseAccumRef.current,
      backgroundMode,
      points: routeCoords.slice(-300),
    });
  };

  const flushPending = async () => {
    setSyncState('syncing');
    const res = await flushSyncQueue();
    setPendingSyncCount(res.remaining);
    setSyncState(res.remaining > 0 ? 'pending' : 'synced');
    if (res.flushed > 0) logDiag(`synced ${res.flushed} pending action(s)`);
  };

  const sendEvent = async (sid: number, event_type: string, payload_json?: string) => {
    try {
      await sessionEvent(sid, event_type, payload_json);
    } catch {
      await enqueueAction('event', sid, { event_type, payload_json });
      await refreshSyncStatus();
    }
  };

  const clearCueTimers = () => {
    for (const t of cueTimers.current) clearTimeout(t);
    cueTimers.current = [];
    cuePlanRef.current = [];
    cueCursorRef.current = 0;
    cueSessionIdRef.current = null;
  };

  const cancelCueNotifications = async () => {
    const ids = cueNotificationIdsRef.current;
    cueNotificationIdsRef.current = [];
    for (const id of ids) {
      try {
        await Notifications.cancelScheduledNotificationAsync(id);
      } catch {
        // ignore
      }
    }
  };

  const scheduleCueNotificationsFromElapsed = async (elapsedSec: number) => {
    await cancelCueNotifications();
    const now = Math.max(0, Math.floor(elapsedSec));
    const remaining = cuePlanRef.current.filter((c) => c.atSec > now);
    const ids: string[] = [];
    for (const c of remaining) {
      const delaySec = Math.max(1, Math.floor(c.atSec - now));
      try {
        const id = await Notifications.scheduleNotificationAsync({
          content: {
            title: 'MotionCoachLab',
            body: c.text,
            sound: cueSoundForType(c.type),
            data: { cueType: c.type },
          },
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
            seconds: delaySec,
            repeats: false,
          },
        });
        ids.push(id);
      } catch {
        // keep scheduling remaining cues
      }
    }
    cueNotificationIdsRef.current = ids;
    logDiag(`lock cues scheduled (${ids.length})`);
  };

  const processDueCues = (elapsedSec: number) => {
    if (!guidedCuesEnabled) return;
    const plan = cuePlanRef.current;
    if (!plan.length) return;

    while (cueCursorRef.current < plan.length && elapsedSec >= plan[cueCursorRef.current].atSec) {
      const c = plan[cueCursorRef.current];
      cueCursorRef.current += 1;

      if (c.type === 'cue_halfway' && !shouldAnnounceTurnaround(pointsRef.current)) {
        logDiag('halfway cue skipped (loop detected)');
        continue;
      }

      speak(c.text, c.type);
      setMsg(`🔊 ${c.text}`);
      logDiag(`cue: ${c.type}`);
      if (cueSessionIdRef.current) {
        sendEvent(cueSessionIdRef.current, c.type).catch(() => null);
      }
    }
  };

  const scheduleCues = async (sid: number) => {
    const plan = intervalPlan || { warmup: 5, run: 1, walk: 1.5, repeats: 8, cooldown: 5 };
    const cues: Array<{ atSec: number; text: string; type: string }> = [];
    let t = 0;
    if (cueDetailMode) {
      cues.push({
        atSec: t,
        text: `Warm-up for ${plan.warmup} minutes. Today is ${plan.repeats} run intervals of ${plan.run} minute with ${plan.walk} minute walk recoveries.`,
        type: 'cue_warmup_intro',
      });
    } else {
      cues.push({ atSec: t, text: `Warm-up walk for ${plan.warmup} minutes`, type: 'cue_warmup' });
    }
    t += plan.warmup * 60;
    for (let i = 0; i < plan.repeats; i += 1) {
      cues.push({ atSec: t, text: `Run ${i + 1} of ${plan.repeats}. Start running now.`, type: 'cue_run' });
      t += plan.run * 60;
      if (i < plan.repeats - 1 && plan.walk > 0) {
        cues.push({ atSec: t, text: `Walk now`, type: 'cue_walk' });
        t += plan.walk * 60;
      }
    }
    cues.push({ atSec: t, text: `Cool-down walk`, type: 'cue_cooldown' });
    const half = Math.floor(t / 2);

    const totalMotion = Math.round(plan.warmup + (plan.repeats * (plan.run + plan.walk)) + plan.cooldown);
    const totalRun = Math.round(plan.repeats * plan.run);
    cues.push({
      atSec: t + (plan.cooldown * 60),
      text: cueDetailMode
        ? `Well done. You completed ${totalRun} minutes running and ${totalMotion} minutes of total motion.`
        : 'Well done. Session complete.',
      type: 'cue_summary',
    });

    cues.push({ atSec: half, text: 'Halfway point. If this is an out and back route, turn around now.', type: 'cue_halfway' });

    cuePlanRef.current = cues.sort((a, b) => a.atSec - b.atSec);
    cueCursorRef.current = 0;
    cueSessionIdRef.current = sid;
    logDiag(`cue plan loaded (${cuePlanRef.current.length} cues)`);
    await scheduleCueNotificationsFromElapsed(0);
  };

  const onStart = async () => {
    if (!(await requestLocation())) return;
    try {
      const s = await startSession(userId);
      setSessionId(s.id);
      setStartedAt(Date.now());
      setSeconds(0);
      setDistanceM(0);
      setIsPaused(false);
      pauseAccumRef.current = 0;
      pauseStartedAtRef.current = null;
      stalledWarnedRef.current = false;
      lastPointTsRef.current = Date.now();
      pointsRef.current = [];
      BG_POINTS = [];
      setRouteCoords([]);
      await cancelCueNotifications();
      await startWatcher();
      await startBackgroundUpdates();
      logDiag(`session started (id ${s.id})`);
      setMsg(backgroundMode ? 'Session started. GPS + background tracking on.' : 'Session started. GPS tracking on.');
      await sendEvent(s.id, 'start');
      if (guidedCuesEnabled) {
        await scheduleCues(s.id);
      }
      await persistActive();
    } catch (e: any) {
      setMsg(e?.message || 'Start failed');
    }
  };

  const onPauseResume = async () => {
    if (!sessionId) return;
    if (!isPaused) {
      setIsPaused(true);
      await cancelCueNotifications();
      pauseStartedAtRef.current = Date.now();
      setMsg('Paused.');
      logDiag('paused');
      try {
        await sendEvent(sessionId, 'pause');
      } catch {}
      await persistActive();
      return;
    }
    setIsPaused(false);
    if (pauseStartedAtRef.current) {
      pauseAccumRef.current += Date.now() - pauseStartedAtRef.current;
      pauseStartedAtRef.current = null;
    }
    setMsg('Resumed.');
    logDiag('resumed');
    try {
      await sendEvent(sessionId, 'resume');
    } catch {}
    await scheduleCueNotificationsFromElapsed(seconds);
    await persistActive();
  };

  const onStop = async () => {
    if (!sessionId) return;
    try {
      watcherRef.current?.remove();
      clearCueTimers();
      await cancelCueNotifications();
      await stopBackgroundUpdates();

      const merged = mergePoints(pointsRef.current, BG_POINTS);
      const mergedDistance = computeDistance(merged);
      const route = merged
        .slice(0, 500)
        .map((p) => `${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`)
        .join(';');

      setDistanceM(mergedDistance);
      setRouteCoords(merged);
      logDiag(`stopped: ${Math.round(mergedDistance)}m in ${seconds}s, points=${merged.length}`);
      const stopPayload = { distance_m: Math.round(mergedDistance), duration_s: Math.max(1, seconds), route_polyline: route || undefined };
      try {
        await stopSession(sessionId, stopPayload.distance_m, stopPayload.duration_s, stopPayload.route_polyline);
      } catch {
        await enqueueAction('stop', sessionId, stopPayload);
        await refreshSyncStatus();
        logDiag('stop queued for sync');
      }
      await clearActiveSession();
      setStartedAt(null);
      setIsPaused(false);
      setMsg('Run saved. Quick check-in: effort, fatigue, and pain/discomfort.');
      setCheckStage('effort');
    } catch (e: any) {
      setMsg(e?.message || 'Stop failed');
    }
  };

  const pushScore = (value: string) => {
    if (checkStage === 'effort') {
      setCheck((x) => ({ ...x, effort: value }));
      setCheckStage('fatigue');
      return;
    }
    if (checkStage === 'fatigue') {
      setCheck((x) => ({ ...x, fatigue: value }));
      setCheckStage('pain_type');
    }
  };

  const deriveSessionFeel = (effort: number, fatigue: number, painType: string): string => {
    if (painType === 'sharp_stride_change' || painType === 'stop_run_pain' || (effort >= 8 && fatigue >= 8)) return 'too_hard';
    if (effort <= 3 && fatigue <= 3 && painType === 'no_pain') return 'too_easy';
    return 'about_right';
  };

  const submitCheckinWithScores = async (painType?: string, painLocation?: string) => {
    if (!sessionId) return;
    const effortN = Number(check.effort);
    const fatigueN = Number(check.fatigue);
    const pType = painType ?? check.pain_type;
    const pLoc = painLocation ?? check.pain_location;
    const painLabel: Record<string, string> = {
      no_pain: 'none',
      normal_discomfort: 'minor',
      niggle: 'minor',
      sharp_stride_change: 'pain_form',
      stop_run_pain: 'pain_form',
    };
    const payload = {
      effort: scoreToEffort(effortN),
      fatigue: scoreToFatigue(fatigueN),
      pain: painLabel[pType] || 'minor',
      session_feel: deriveSessionFeel(effortN, fatigueN, pType),
      notes: `scores effort=${effortN}, fatigue=${fatigueN}, pain_type=${pType}, pain_location=${pLoc || 'na'}`,
    };
    try {
      const res = await checkinSession(sessionId, payload);
      setCheckStage('done');
      setMsg(res.actions_applied?.length ? `Saved. ${res.actions_applied.join(' ')}` : 'Saved. No changes needed.');
      setSessionId(null);
      setCheck({ effort: '', fatigue: '', pain_type: '', pain_location: '' });
      await clearActiveSession();
    } catch (e: any) {
      try {
        await enqueueAction('checkin', sessionId, payload);
        await refreshSyncStatus();
        setCheckStage('done');
        setMsg('Check-in saved locally. Will sync when network is available.');
        setSessionId(null);
        setCheck({ effort: '', fatigue: '', pain_type: '', pain_location: '' });
      } catch {
        setMsg(e?.message || 'Check-in failed');
      }
    }
  };

  const selectPainType = (painType: string) => {
    setCheck((x) => ({ ...x, pain_type: painType }));
    if (painType === 'niggle' || painType === 'sharp_stride_change' || painType === 'stop_run_pain') {
      setCheckStage('pain_location');
      return;
    }
    submitCheckinWithScores(painType, '');
  };

  const selectPainLocation = (painLocation: string) => {
    setCheck((x) => ({ ...x, pain_location: painLocation }));
    submitCheckinWithScores(check.pain_type, painLocation);
  };

  const region = useMemo(() => buildRegion(routeCoords), [routeCoords]);

  return (
    <View style={styles.wrap}>
      <View style={styles.card}>
        <Text style={styles.h1}>Live Run</Text>
        <Text style={styles.meta}>Sync: {syncState}{pendingSyncCount ? ` (${pendingSyncCount} pending)` : ''}</Text>
        <Text style={styles.p}>Elapsed: {elapsed}</Text>
        <Text style={styles.p}>Distance: {distanceLabel}</Text>
        <Text style={styles.p}>Pace: {pace}</Text>

        {!startedAt ? (
          <>
          <View style={styles.row}>
            <Pressable
              style={[styles.smallBtn, backgroundMode && styles.toggleOn]}
              onPress={() => setBackgroundMode((v) => !v)}
            >
              <Text style={styles.smallBtnText}>Background: {backgroundMode ? 'On' : 'Off'}</Text>
            </Pressable>
            <Pressable
              style={[styles.smallBtn, guidedCuesEnabled && styles.toggleOn]}
              onPress={() => setGuidedCuesEnabled((v) => !v)}
            >
              <Text style={styles.smallBtnText}>Guided Cues: {guidedCuesEnabled ? 'On' : 'Off'}</Text>
            </Pressable>
            <Pressable
              style={[styles.smallBtn, cueDetailMode && styles.toggleOn]}
              onPress={() => onCueDetailModeChange(!cueDetailMode)}
            >
              <Text style={styles.smallBtnText}>Cue Detail: {cueDetailMode ? 'On' : 'Off'}</Text>
            </Pressable>
          </View>
          <View style={styles.row}>
            <Pressable
              style={styles.smallBtn}
              onPress={() => {
                if (!voiceOptions.length) return;
                const next = (voiceIdx + 1) % voiceOptions.length;
                setVoiceIdx(next);
                const v = voiceOptions[next];
                speak(`Voice selected: ${v?.name || 'Default'}`, 'voice_selected');
                logDiag(`voice selected ${v?.name || 'Default'}`);
              }}
            >
              <Text style={styles.smallBtnText}>Voice: {voiceOptions.length ? voiceOptions[voiceIdx]?.name : 'Default'}</Text>
            </Pressable>
            <Pressable
              style={styles.smallBtn}
              onPress={() => speak('Voice test. Run cues are ready.', 'voice_test')}
            >
              <Text style={styles.smallBtnText}>Test Voice</Text>
            </Pressable>
            <Pressable style={styles.primary} onPress={onStart}>
              <Text style={styles.primaryText}>Start Run</Text>
            </Pressable>
          </View>
          </>
        ) : (
          <View style={styles.row}>
            <Pressable style={styles.smallBtn} onPress={onPauseResume}>
              <Text style={styles.smallBtnText}>{isPaused ? 'Resume' : 'Pause'}</Text>
            </Pressable>
            <Pressable style={styles.stop} onPress={onStop}>
              <Text style={styles.primaryText}>Stop Run</Text>
            </Pressable>
          </View>
        )}
      </View>

      {region && routeCoords.length >= 2 ? (
        <View style={styles.mapCard}>
          <Text style={styles.h2}>Route Preview</Text>
          <MapView style={styles.map} initialRegion={region}>
            <Polyline
              coordinates={routeCoords.map((p) => ({ latitude: p.latitude, longitude: p.longitude }))}
              strokeWidth={4}
              strokeColor="#5a8f2f"
            />
            <Marker coordinate={{ latitude: routeCoords[0].latitude, longitude: routeCoords[0].longitude }} title="Start" />
            <Marker
              coordinate={{
                latitude: routeCoords[routeCoords.length - 1].latitude,
                longitude: routeCoords[routeCoords.length - 1].longitude,
              }}
              title="Finish"
            />
          </MapView>
        </View>
      ) : null}

      {checkStage !== 'none' && checkStage !== 'done' ? (
        <View style={styles.card}>
          <Text style={styles.h2}>
            {checkStage === 'effort' && 'How hard was it?'}
            {checkStage === 'fatigue' && 'Leg fatigue right now?'}
            {checkStage === 'pain_type' && 'Any pain or discomfort?'}
            {checkStage === 'pain_location' && 'Where is it?'}
          </Text>
          {(checkStage === 'effort' || checkStage === 'fatigue') ? (
            <View style={styles.rowWrap}>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                <Pressable key={n} style={styles.scoreBtn} onPress={() => pushScore(String(n))}>
                  <Text>{n}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          {checkStage === 'pain_type' ? (
            <View style={styles.rowWrap}>
              <Pressable style={styles.choiceBtn} onPress={() => selectPainType('no_pain')}><Text style={styles.choiceText}>No pain</Text></Pressable>
              <Pressable style={styles.choiceBtn} onPress={() => selectPainType('normal_discomfort')}><Text style={styles.choiceText}>Normal training discomfort</Text></Pressable>
              <Pressable style={styles.choiceBtn} onPress={() => selectPainType('niggle')}><Text style={styles.choiceText}>Niggle</Text></Pressable>
              <Pressable style={styles.choiceBtn} onPress={() => selectPainType('sharp_stride_change')}><Text style={styles.choiceText}>Sharp pain / changed stride</Text></Pressable>
              <Pressable style={styles.choiceBtn} onPress={() => selectPainType('stop_run_pain')}><Text style={styles.choiceText}>Stop-run pain</Text></Pressable>
            </View>
          ) : null}
          {checkStage === 'pain_location' ? (
            <View style={styles.rowWrap}>
              {['Foot/ankle', 'Shin/calf', 'Knee', 'Hip', 'Back', 'Other'].map((label) => (
                <Pressable key={label} style={styles.choiceBtn} onPress={() => selectPainLocation(label)}>
                  <Text style={styles.choiceText}>{label}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}

      {msg ? <Text style={styles.msg}>{msg}</Text> : null}
      <Pressable style={styles.syncBtn} onPress={flushPending}>
        <Text style={styles.syncBtnText}>Sync Pending Now</Text>
      </Pressable>
      <View style={styles.diagCard}>
        <Text style={styles.h2}>Session Diagnostics</Text>
        {diag.length ? diag.map((d, i) => <Text key={i} style={styles.diagLine}>{d}</Text>) : <Text style={styles.meta}>No events yet.</Text>}
      </View>
    </View>
  );
}

function mergePoints(fg: Coord[], bg: Coord[]): Coord[] {
  const all = [...fg, ...bg];
  all.sort((a, b) => a.ts - b.ts);
  const out: Coord[] = [];
  let last: Coord | null = null;
  for (const p of all) {
    if (!last) {
      out.push(p);
      last = p;
      continue;
    }
    const d = segmentMeters(last, p);
    if (d > 0) {
      out.push(p);
      last = p;
    }
  }
  return out;
}

function computeDistance(points: Coord[]): number {
  if (points.length < 2) return 0;
  let d = 0;
  for (let i = 1; i < points.length; i += 1) {
    d += segmentMeters(points[i - 1], points[i]);
  }
  return d;
}

function segmentMeters(prev: Coord, next: Coord): number {
  const d = haversineMeters(prev.latitude, prev.longitude, next.latitude, next.longitude);
  if (d < 0.7) return 0;
  const dt = Math.max(1, (next.ts - prev.ts) / 1000);
  const speed = d / dt;
  const pSpeed = prev.speed && prev.speed > 0 ? prev.speed : 0;
  const nSpeed = next.speed && next.speed > 0 ? next.speed : 0;
  const expectedMax = Math.max(7.5, pSpeed + 5, nSpeed + 5);
  const acc = Math.max(prev.accuracy || 15, next.accuracy || 15);

  // Reject jumps that are too fast for running and exceed GPS uncertainty.
  if (speed > expectedMax && d > acc * 3) return 0;
  if (d > 250 && speed > 8) return 0;
  return d;
}

function shouldAnnounceTurnaround(points: Coord[]): boolean {
  if (points.length < 20) return true;
  const latest = points[points.length - 1];
  let nearCount = 0;
  for (let i = 0; i < points.length - 20; i += 4) {
    const p = points[i];
    const d = haversineMeters(latest.latitude, latest.longitude, p.latitude, p.longitude);
    if (d < 30) nearCount += 1;
    if (nearCount >= 3) return false;
  }
  const start = points[0];
  const displacement = haversineMeters(start.latitude, start.longitude, latest.latitude, latest.longitude);
  const traveled = computeDistance(points);
  if (traveled < 400) return false;
  if (displacement < 80) return false;
  return true;
}

function buildRegion(points: Coord[]) {
  if (!points.length) return null;
  const lats = points.map((p) => p.latitude);
  const lons = points.map((p) => p.longitude);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLon + maxLon) / 2,
    latitudeDelta: Math.max(0.005, (maxLat - minLat) * 1.5),
    longitudeDelta: Math.max(0.005, (maxLon - minLon) * 1.5),
  };
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function scoreToEffort(score: number): string {
  if (score >= 9) return 'max';
  if (score >= 7) return 'hard';
  if (score >= 4) return 'moderate';
  return 'easy';
}

function scoreToFatigue(score: number): string {
  if (score >= 8) return 'very_heavy';
  if (score >= 5) return 'heavy';
  return 'fresh';
}

function cueSoundForType(cueType: string): string {
  const map: Record<string, string> = {
    cue_warmup_intro: 'warmup_intro.wav',
    cue_warmup: 'warmup.wav',
    cue_run: 'run.wav',
    cue_walk: 'walk.wav',
    cue_cooldown: 'cooldown.wav',
    cue_summary: 'summary.wav',
    cue_halfway: 'halfway.wav',
  };
  return map[cueType] || 'default';
}

const styles = StyleSheet.create({
  wrap: { gap: 12 },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#dae6ce', gap: 8 },
  mapCard: { backgroundColor: '#fff', borderRadius: 12, padding: 10, borderWidth: 1, borderColor: '#dae6ce', gap: 8 },
  map: { height: 220, borderRadius: 8 },
  h1: { fontSize: 18, fontWeight: '700', color: '#1f2d1f' },
  h2: { fontSize: 16, fontWeight: '700', color: '#1f2d1f' },
  p: { color: '#203020' },
  primary: { flex: 1, backgroundColor: '#6b8f41', borderRadius: 10, padding: 12, alignItems: 'center' },
  stop: { flex: 1, backgroundColor: '#b4492f', borderRadius: 10, padding: 12, alignItems: 'center' },
  toggleOn: { backgroundColor: '#d7ebc8' },
  primaryText: { color: '#fff', fontWeight: '700' },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  scoreBtn: { width: 42, height: 42, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: '#edf4e7' },
  choiceBtn: { minHeight: 40, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: '#edf4e7', paddingHorizontal: 12, paddingVertical: 10 },
  choiceText: { color: '#243824', fontWeight: '600' },
  row: { flexDirection: 'row', gap: 8 },
  smallBtn: { flex: 1, padding: 10, alignItems: 'center', borderRadius: 8, backgroundColor: '#edf4e7' },
  smallBtnText: { fontWeight: '700' },
  msg: { color: '#203020' },
  meta: { color: '#526c49', fontSize: 12 },
  syncBtn: { backgroundColor: '#e8f0df', borderRadius: 8, paddingVertical: 8, alignItems: 'center' },
  syncBtnText: { color: '#37522d', fontWeight: '700', fontSize: 12 },
  diagCard: { backgroundColor: '#fff', borderRadius: 12, padding: 10, borderWidth: 1, borderColor: '#dae6ce', gap: 4 },
  diagLine: { color: '#4b6143', fontSize: 12 },
});
