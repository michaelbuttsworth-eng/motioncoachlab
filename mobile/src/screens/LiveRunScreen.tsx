import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, AppState, NativeModules, Platform, Pressable, ScrollView, StyleSheet, Text, Vibration, View, useWindowDimensions } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Svg, { Circle } from 'react-native-svg';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import * as Notifications from 'expo-notifications';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
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
import { shadow, theme } from '../ui/theme';

type CheckStage = 'none' | 'feel' | 'done';
type FeelValue = 'very_easy' | 'easy' | 'moderate' | 'hard' | 'very_hard';
type RunSummary = {
  mode: SessionMode;
  durationSec: number;
  distanceM: number;
  endedAtMs: number;
  feel?: FeelValue;
};

type Coord = { latitude: number; longitude: number; ts: number; accuracy?: number; speed?: number | null };

const CUE_AUDIO_ASSETS: Record<string, number> = {
  cue_warmup_intro: require('../../assets/audio/cues/warmup_intro.wav'),
  cue_warmup: require('../../assets/audio/cues/warmup.wav'),
  cue_prerun: require('../../assets/audio/cues/prerun.wav'),
  cue_run: require('../../assets/audio/cues/run.wav'),
  cue_walk: require('../../assets/audio/cues/walk.wav'),
  cue_cooldown: require('../../assets/audio/cues/cooldown.wav'),
  cue_summary: require('../../assets/audio/cues/summary.wav'),
  cue_halfway: require('../../assets/audio/cues/halfway.wav'),
  cue_run_start: require('../../assets/audio/cues/run_start.wav'),
  cue_run_end: require('../../assets/audio/cues/run_finish.wav'),
  cue_walk_start: require('../../assets/audio/cues/walk_start.wav'),
  cue_walk_end: require('../../assets/audio/cues/walk_finish.wav'),
  cue_countdown_tick: require('../../assets/audio/cues/countdown_tick.wav'),
};
const START_COUNTDOWN_SEC = 5;
type SessionMode = 'run' | 'walk';

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
  backgroundMode,
  guidedCuesEnabled,
  cueDetailMode,
  keepScreenAwake,
  testWarmupMin,
}: {
  userId: number;
  backgroundMode: boolean;
  guidedCuesEnabled: boolean;
  cueDetailMode: boolean;
  keepScreenAwake: boolean;
  testWarmupMin: 1 | 5;
}) {
  const { width } = useWindowDimensions();
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [distanceM, setDistanceM] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [msg, setMsg] = useState('');
  const [checkStage, setCheckStage] = useState<CheckStage>('none');
  const [isStopping, setIsStopping] = useState(false);
  const [activeMode, setActiveMode] = useState<SessionMode>('run');
  const [guidedSession, setGuidedSession] = useState(false);
  const [countdownSec, setCountdownSec] = useState<number | null>(null);
  const [pendingStart, setPendingStart] = useState<{ mode: SessionMode; guided: boolean } | null>(null);
  const [check, setCheck] = useState({ session_feel: '' });
  const [lastRunSummary, setLastRunSummary] = useState<RunSummary | null>(null);
  const [routeCoords, setRouteCoords] = useState<Coord[]>([]);
  const [intervalPlan, setIntervalPlan] = useState<{ warmup: number; run: number; walk: number; repeats: number; cooldown: number } | null>(null);
  const [diag, setDiag] = useState<string[]>([]);
  const [syncState, setSyncState] = useState<'synced' | 'syncing' | 'pending'>('synced');
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [readinessIssues, setReadinessIssues] = useState<string[]>([]);
  const [scheduledCueCount, setScheduledCueCount] = useState(0);
  const [lastCueFired, setLastCueFired] = useState('');
  const DIAG_STORAGE_KEY = 'mcl_session_diag_v1';
  const legAnim = useRef(new Animated.Value(1)).current;

  const watcherRef = useRef<Location.LocationSubscription | null>(null);
  const pointsRef = useRef<Coord[]>([]);
  const cueTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const cuePlanRef = useRef<Array<{ atSec: number; text: string; type: string }>>([]);
  const totalPlannedSecRef = useRef(0);
  const cueCursorRef = useRef(0);
  const cueSessionIdRef = useRef<number | null>(null);
  const cueNotificationIdsRef = useRef<string[]>([]);
  const cuePlayersRef = useRef<Record<string, any>>({});
  const localCueUnduckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pauseAccumRef = useRef<number>(0);
  const pauseStartedAtRef = useRef<number | null>(null);
  const lastPointTsRef = useRef<number | null>(null);
  const stalledWarnedRef = useRef(false);
  const appStateRef = useRef(AppState.currentState);
  const speechAudioModeRef = useRef(false);
  const notifReceivedSubRef = useRef<any>(null);
  const liveModuleRef = useRef<any>(Platform.OS === 'ios' ? (NativeModules as any).MCLiveActivityManager : null);
  const healthModuleRef = useRef<any>(Platform.OS === 'ios' ? (NativeModules as any).MCLHealthKitManager : null);
  const latestSessionRef = useRef<number | null>(null);
  const latestSecondsRef = useRef(0);
  const latestDistanceRef = useRef(0);

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

  const computePaceMinPerKm = (elapsedSec: number, meters: number) => {
    if (elapsedSec <= 0 || meters <= 0) return 0;
    return (elapsedSec / 60) / (meters / 1000);
  };

  const deriveLivePhase = (elapsedSec: number, paused: boolean) => {
    if (paused) return 'Paused';
    if (!cuePlanRef.current.length) return activeMode === 'walk' ? 'Walking' : 'Running';
    let phase = 'Running';
    for (const c of cuePlanRef.current) {
      if (elapsedSec < c.atSec) break;
      if (c.type === 'cue_warmup' || c.type === 'cue_warmup_intro') phase = 'Warm-up';
      if (c.type === 'cue_run') phase = 'Run';
      if (c.type === 'cue_walk') phase = 'Walk';
      if (c.type === 'cue_cooldown') phase = 'Cool-down';
    }
    return phase;
  };

  const deriveLiveSegment = (elapsedSec: number, paused: boolean) => {
    const runs = cuePlanRef.current.filter((c) => c.type === 'cue_run');
    const walks = cuePlanRef.current.filter((c) => c.type === 'cue_walk');
    const totalRuns = runs.length;

    const phaseCueTypes = new Set(['cue_warmup', 'cue_warmup_intro', 'cue_run', 'cue_walk', 'cue_cooldown', 'cue_summary']);
    const phaseCues = cuePlanRef.current.filter((c) => phaseCueTypes.has(c.type));
    if (!phaseCues.length) {
      const phase = deriveLivePhase(elapsedSec, paused);
      const nowEpoch = Date.now() / 1000;
      return {
        phase,
        phaseLabel: phase,
        segmentRemainingSec: 0,
        sessionStartedAtEpoch: nowEpoch - Math.max(0, elapsedSec),
        segmentEndsAtEpoch: nowEpoch,
        blockProgress: 0,
        intervalCurrent: 0,
        intervalTotal: 0,
      };
    }
    let current = phaseCues[0] || { atSec: 0, type: 'cue_run', text: '' };
    let next: { atSec: number; type: string; text: string } | null = null;
    for (let i = 0; i < phaseCues.length; i += 1) {
      const c = phaseCues[i];
      if (elapsedSec >= c.atSec) {
        current = c;
        next = phaseCues[i + 1] || null;
      } else {
        break;
      }
    }

    const remaining = next ? Math.max(0, next.atSec - elapsedSec) : 0;
    const blockDurationSec = next ? Math.max(1, next.atSec - current.atSec) : Math.max(1, remaining);
    const blockElapsedSec = Math.max(0, Math.min(blockDurationSec, elapsedSec - current.atSec));
    const blockProgress = blockDurationSec > 0 ? Math.min(1, blockElapsedSec / blockDurationSec) : 0;
    const nowEpoch = Date.now() / 1000;
    const sessionStartedAtEpoch = nowEpoch - Math.max(0, elapsedSec);
    const segmentEndsAtEpoch = nowEpoch + remaining;
    const phase = deriveLivePhase(elapsedSec, paused);

    if (paused) {
      return {
        phase,
        phaseLabel: 'Paused',
        segmentRemainingSec: remaining,
        sessionStartedAtEpoch,
        segmentEndsAtEpoch,
        blockProgress,
        intervalCurrent: 0,
        intervalTotal: totalRuns,
      };
    }

    if (current.type === 'cue_run') {
      const idx = runs.findIndex((c) => c.atSec === current.atSec) + 1;
      return {
        phase,
        phaseLabel: `Run ${idx}/${Math.max(1, totalRuns)}`,
        segmentRemainingSec: remaining,
        sessionStartedAtEpoch,
        segmentEndsAtEpoch,
        blockProgress,
        intervalCurrent: idx,
        intervalTotal: Math.max(1, totalRuns),
      };
    }
    if (current.type === 'cue_walk') {
      const idx = walks.findIndex((c) => c.atSec === current.atSec) + 1;
      return {
        phase,
        phaseLabel: `Walk ${idx}/${Math.max(1, totalRuns)}`,
        segmentRemainingSec: remaining,
        sessionStartedAtEpoch,
        segmentEndsAtEpoch,
        blockProgress,
        intervalCurrent: idx,
        intervalTotal: Math.max(1, totalRuns),
      };
    }
    if (current.type === 'cue_warmup' || current.type === 'cue_warmup_intro') {
      return {
        phase,
        phaseLabel: 'Warm-up',
        segmentRemainingSec: remaining,
        sessionStartedAtEpoch,
        segmentEndsAtEpoch,
        blockProgress,
        intervalCurrent: 0,
        intervalTotal: Math.max(1, totalRuns),
      };
    }
    if (current.type === 'cue_cooldown') {
      return {
        phase,
        phaseLabel: 'Cool-down',
        segmentRemainingSec: remaining,
        sessionStartedAtEpoch,
        segmentEndsAtEpoch,
        blockProgress,
        intervalCurrent: totalRuns,
        intervalTotal: Math.max(1, totalRuns),
      };
    }
    return {
      phase,
      phaseLabel: phase,
      segmentRemainingSec: remaining,
      sessionStartedAtEpoch,
      segmentEndsAtEpoch,
      blockProgress,
      intervalCurrent: 0,
      intervalTotal: Math.max(1, totalRuns),
    };
  };

  const startLiveActivity = async (sid: number, elapsedSec: number, meters: number, paused: boolean) => {
    if (Platform.OS !== 'ios') return;
    const mod = liveModuleRef.current;
    if (!mod?.start) {
      logDiag('live activity unavailable (native module missing)');
      return;
    }
    const seg = deriveLiveSegment(elapsedSec, paused);
    try {
      await mod.start({
        sessionId: String(sid),
        elapsedSec,
        segmentRemainingSec: seg.segmentRemainingSec,
        sessionStartedAtEpoch: seg.sessionStartedAtEpoch,
        segmentEndsAtEpoch: seg.segmentEndsAtEpoch,
        distanceM: meters,
        paceMinPerKm: computePaceMinPerKm(elapsedSec, meters),
        progress: seg.blockProgress,
        phase: seg.phase,
        phaseLabel: seg.phaseLabel,
        isPaused: paused,
        intervalCurrent: seg.intervalCurrent,
        intervalTotal: seg.intervalTotal,
      });
      logDiag('live activity started');
    } catch (e: any) {
      logDiag(`live activity start failed: ${String(e?.message || e || 'unknown')}`);
    }
  };

  const updateLiveActivity = async (sid: number, elapsedSec: number, meters: number, paused: boolean) => {
    if (Platform.OS !== 'ios') return;
    const mod = liveModuleRef.current;
    if (!mod?.update) return;
    const seg = deriveLiveSegment(elapsedSec, paused);
    try {
      await mod.update({
        sessionId: String(sid),
        elapsedSec,
        segmentRemainingSec: seg.segmentRemainingSec,
        sessionStartedAtEpoch: seg.sessionStartedAtEpoch,
        segmentEndsAtEpoch: seg.segmentEndsAtEpoch,
        distanceM: meters,
        paceMinPerKm: computePaceMinPerKm(elapsedSec, meters),
        progress: seg.blockProgress,
        phase: seg.phase,
        phaseLabel: seg.phaseLabel,
        isPaused: paused,
        intervalCurrent: seg.intervalCurrent,
        intervalTotal: seg.intervalTotal,
      });
    } catch {
      // keep running if live activity update fails
    }
  };

  const endLiveActivity = async (sid: number | null, elapsedSec: number, meters: number) => {
    if (Platform.OS !== 'ios') return;
    if (!sid) return;
    const mod = liveModuleRef.current;
    if (!mod?.end) return;
    try {
      await mod.end({
        sessionId: String(sid),
        elapsedSec,
        segmentRemainingSec: 0,
        sessionStartedAtEpoch: Date.now() / 1000 - Math.max(0, elapsedSec),
        segmentEndsAtEpoch: Date.now() / 1000,
        distanceM: meters,
        paceMinPerKm: computePaceMinPerKm(elapsedSec, meters),
        progress: 1,
        phase: 'Completed',
        phaseLabel: 'Completed',
        isPaused: false,
        intervalCurrent: 0,
        intervalTotal: 0,
      });
      logDiag('live activity ended');
    } catch {
      logDiag('live activity end failed');
    }
  };

  const startNativeCuePlayback = async (elapsedSec: number) => {
    if (Platform.OS !== 'ios') return;
    const mod = liveModuleRef.current;
    if (!mod?.startCues) return;
    try {
      const runs = cuePlanRef.current.filter((c) => c.type === 'cue_run');
      const totalRuns = Math.max(1, runs.length);
      const phaseCues = cuePlanRef.current.filter((c) =>
        ['cue_warmup_intro', 'cue_warmup', 'cue_prerun', 'cue_run', 'cue_walk', 'cue_cooldown', 'cue_summary', 'cue_halfway'].includes(c.type)
      );
      const cues = phaseCues.map((c, idx) => {
        const next = phaseCues[idx + 1];
        const runIndex = c.type === 'cue_run' ? runs.findIndex((r) => r.atSec === c.atSec) + 1 : 0;
        const walkIndex = c.type === 'cue_walk' ? cuePlanRef.current.filter((x) => x.type === 'cue_walk').findIndex((w) => w.atSec === c.atSec) + 1 : 0;
        const phase =
          c.type === 'cue_run' ? 'Run' :
          c.type === 'cue_walk' ? 'Walk' :
          c.type === 'cue_cooldown' ? 'Cool-down' :
          c.type === 'cue_halfway' ? 'Halfway' :
          c.type === 'cue_summary' ? 'Completed' :
          'Warm-up';
        const phaseLabel =
          c.type === 'cue_run' ? `Run ${runIndex}/${totalRuns}` :
          c.type === 'cue_walk' ? `Walk ${walkIndex}/${totalRuns}` :
          c.type === 'cue_prerun' ? 'Get Ready' :
          c.type === 'cue_cooldown' ? 'Cool-down' :
          c.type === 'cue_halfway' ? 'Halfway' :
          c.type === 'cue_summary' ? 'Completed' :
          'Warm-up';
        return {
          atSec: c.atSec,
          cueType: c.type,
          phase,
          phaseLabel,
          segmentStartAtSec: c.atSec,
          segmentEndsAtSec: next ? next.atSec : c.atSec + 30,
          intervalCurrent: c.type === 'cue_run' ? runIndex : c.type === 'cue_walk' ? walkIndex : 0,
          intervalTotal: totalRuns,
        };
      });
      await mod.startCues({
        cues,
        elapsedSec,
        sessionStartedAtEpoch: Date.now() / 1000 - Math.max(0, elapsedSec),
      });
      logDiag(`native lock cues armed (${cues.length})`);
    } catch {
      logDiag('native lock cues arm failed');
    }
  };

  const stopNativeCuePlayback = async () => {
    if (Platform.OS !== 'ios') return;
    const mod = liveModuleRef.current;
    if (!mod?.stopCues) return;
    try {
      await mod.stopCues();
      logDiag('native lock cues stopped');
    } catch {
      // ignore
    }
  };

  const playLocalCue = async (cueType: string, options?: { duck?: boolean }) => {
    const source = CUE_AUDIO_ASSETS[cueType];
    if (!source) return;
    try {
      const shouldDuck = options?.duck !== false;
      if (shouldDuck) {
        await setSpeechAudioMode(true);
      }
      let player = cuePlayersRef.current[cueType];
      if (!player) {
        player = createAudioPlayer(source);
        cuePlayersRef.current[cueType] = player;
      }
      try {
        await player.seekTo(0);
      } catch {
        // continue
      }
      player.play();
      logDiag(`local cue play ${cueType}`);
      if (shouldDuck) {
        if (localCueUnduckTimerRef.current) clearTimeout(localCueUnduckTimerRef.current);
        localCueUnduckTimerRef.current = setTimeout(() => {
          setSpeechAudioMode(false).catch(() => null);
        }, 4500);
      }
    } catch {
      logDiag(`local cue failed ${cueType}`);
    }
  };

  const evaluateReadiness = async () => {
    const issues: string[] = [];
    try {
      const n = await Notifications.getPermissionsAsync();
      if (!n.granted) issues.push('Notifications are off');
      if (n.granted && n.ios && n.ios.allowsSound === false) issues.push('Notification sounds are off');
    } catch {
      issues.push('Could not verify notifications');
    }
    try {
      const fg = await Location.getForegroundPermissionsAsync();
      const bg = await Location.getBackgroundPermissionsAsync();
      if (fg.status !== 'granted') issues.push('Location permission is not granted');
      if (bg.status !== 'granted') issues.push('Background location is not granted');
    } catch {
      issues.push('Could not verify location permissions');
    }
    setReadinessIssues(issues);
    return issues;
  };

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
    const preloadHealthSnapshot = async () => {
      if (Platform.OS !== 'ios') return;
      const mod = healthModuleRef.current;
      if (!mod?.readRecoverySnapshot) return;
      try {
        const snapshot = await mod.readRecoverySnapshot();
        const sleep = Number(snapshot?.sleepHours);
        const rhr = Number(snapshot?.restingHeartRate);
        if (Number.isFinite(sleep) || Number.isFinite(rhr)) {
          logDiag(
            `health snapshot${Number.isFinite(sleep) ? ` sleep=${sleep}h` : ''}${Number.isFinite(rhr) ? ` rhr=${Math.round(rhr)}` : ''}`
          );
        }
      } catch {
        // Do not block run flow if HealthKit read fails.
      }
    };
    preloadHealthSnapshot();
  }, []);

  useEffect(() => {
    const setupNotifications = async () => {
      try {
        await Notifications.setNotificationHandler({
          handleNotification: async () => {
            const isActive = appStateRef.current === 'active';
            return {
              shouldShowBanner: !isActive,
              shouldShowList: true,
              shouldPlaySound: true,
              shouldSetBadge: false,
            };
          },
        });
      } catch {
        // Continue without lock-screen cue notifications.
      }
    };
    setupNotifications();
    notifReceivedSubRef.current = Notifications.addNotificationReceivedListener((n) => {
      const data = (n.request.content.data || {}) as any;
      const cueType = String(data?.cueType || '');
      if (!cueType.startsWith('cue_')) return;
      logDiag(`notif delivered ${cueType}`);
      const sid = cueSessionIdRef.current || Number(data?.sessionId || 0) || null;
      if (sid) {
        sendEvent(sid, 'cue_notification_delivered', JSON.stringify({ cue_type: cueType })).catch(() => null);
      }
    });
    const sub = AppState.addEventListener('change', (state) => {
      appStateRef.current = state;
      if (state !== 'active') {
        setSpeechAudioMode(false).catch(() => null);
      } else {
        evaluateReadiness().catch(() => null);
      }
    });
    return () => {
      sub.remove();
      if (notifReceivedSubRef.current) {
        notifReceivedSubRef.current.remove();
        notifReceivedSubRef.current = null;
      }
    };
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
    latestSessionRef.current = sessionId;
    latestSecondsRef.current = seconds;
    latestDistanceRef.current = distanceM;
  }, [sessionId, seconds, distanceM]);

  useEffect(() => {
    return () => {
      watcherRef.current?.remove();
      clearCueTimers();
      cancelCueNotifications().catch(() => null);
      cancelAllCoachCueNotifications().catch(() => null);
      stopNativeCuePlayback().catch(() => null);
      stopBackgroundUpdates();
      setSpeechAudioMode(false).catch(() => null);
      endLiveActivity(latestSessionRef.current, latestSecondsRef.current, latestDistanceRef.current).catch(() => null);
      if (localCueUnduckTimerRef.current) {
        clearTimeout(localCueUnduckTimerRef.current);
        localCueUnduckTimerRef.current = null;
      }
      Object.values(cuePlayersRef.current).forEach((p: any) => {
        try { p.remove?.(); } catch {}
      });
      cuePlayersRef.current = {};
    };
  }, []);

  useEffect(() => {
    const applyKeepAwake = async () => {
      if (keepScreenAwake && !!startedAt) {
        try {
          await activateKeepAwakeAsync('live-run');
        } catch {
          // ignore
        }
        return;
      }
      try {
        await deactivateKeepAwake('live-run');
      } catch {
        // ignore
      }
    };
    applyKeepAwake();
  }, [keepScreenAwake, startedAt]);

  useEffect(() => {
    return () => {
      deactivateKeepAwake('live-run').catch(() => null);
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
        setActiveMode((recovered as any).mode === 'walk' ? 'walk' : 'run');
        setGuidedSession(!!(recovered as any).guidedSession);
        // keep restored state only for this active session snapshot
        pauseAccumRef.current = Number(recovered.pauseAccumMs || 0);
        pointsRef.current = recovered.points || [];
        setRouteCoords(recovered.points || []);
        logDiag(`recovered session ${recovered.sessionId}`);
        if (!recovered.isPaused) {
          await startWatcher();
          await startBackgroundUpdates();
        }
        await startLiveActivity(recovered.sessionId, recovered.seconds || 0, recovered.distanceM || 0, !!recovered.isPaused);
      } else {
        // Clear stale run/walk notifications left behind from a prior app termination.
        await cancelAllCoachCueNotifications();
      }
      await refreshSyncStatus();
      await evaluateReadiness();
    };
    boot();
  }, [userId]);

  useEffect(() => {
    if (!sessionId || !startedAt) return;
    updateLiveActivity(sessionId, seconds, distanceM, isPaused).catch(() => null);
  }, [sessionId, startedAt, seconds, distanceM, isPaused]);

  useEffect(() => {
    if (!startedAt || !sessionId) return;
    const id = setInterval(() => {
      persistActive().catch(() => null);
    }, 15000);
    return () => clearInterval(id);
  }, [startedAt, sessionId, seconds, distanceM, isPaused, backgroundMode, activeMode, guidedSession, routeCoords.length]);

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
    const secPerKm = Math.round(seconds / (distanceM / 1000));
    const mm = Math.floor(secPerKm / 60);
    const ss = secPerKm % 60;
    return `${mm}:${String(ss).padStart(2, '0')}"/km`;
  }, [distanceM, seconds]);
  const liveSeg = useMemo(() => deriveLiveSegment(seconds, isPaused), [seconds, isPaused, activeMode]);
  const legLabel = useMemo(() => {
    if (!startedAt && countdownSec === null) return 'Ready';
    if (countdownSec !== null) {
      return pendingStart?.mode === 'walk' ? 'Starting walk' : 'Starting run';
    }
    if (liveSeg.phaseLabel.startsWith('Run ')) {
      const parts = liveSeg.phaseLabel.replace('Run ', '').split('/');
      return `Run ${parts[0] || '1'} of ${parts[1] || parts[0] || '1'}`;
    }
    if (liveSeg.phaseLabel.startsWith('Walk ')) {
      const parts = liveSeg.phaseLabel.replace('Walk ', '').split('/');
      return `Walk ${parts[0] || '1'} of ${parts[1] || parts[0] || '1'}`;
    }
    return liveSeg.phaseLabel;
  }, [startedAt, countdownSec, liveSeg.phaseLabel, pendingStart?.mode]);
  const legRemaining = useMemo(() => {
    if (!startedAt && countdownSec === null) return '00:00';
    if (countdownSec !== null) return String(Math.max(0, countdownSec));
    if (!guidedSession || cuePlanRef.current.length === 0) {
      const s = Math.max(0, Math.floor(seconds));
      const mm = String(Math.floor(s / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      return `${mm}:${ss}`;
    }
    const s = Math.max(0, Math.floor(liveSeg.segmentRemainingSec || 0));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }, [startedAt, countdownSec, guidedSession, liveSeg.segmentRemainingSec, seconds]);
  const ringProgress = useMemo(() => {
    if (countdownSec !== null) {
      return Math.max(0, Math.min(1, (START_COUNTDOWN_SEC - countdownSec) / START_COUNTDOWN_SEC));
    }
    return Math.max(0, Math.min(1, liveSeg.blockProgress || 0));
  }, [countdownSec, liveSeg.blockProgress]);
  const ringSize = useMemo(() => Math.max(208, Math.min(288, width - 92)), [width]);
  const ringStroke = ringSize < 235 ? 10 : 12;

  useEffect(() => {
    Animated.sequence([
      Animated.timing(legAnim, { toValue: 0.86, duration: 120, useNativeDriver: true }),
      Animated.spring(legAnim, { toValue: 1, friction: 7, tension: 120, useNativeDriver: true }),
    ]).start();
  }, [legLabel, legAnim]);

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
          notificationTitle: 'Motion Coach run in progress',
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

  const logDiag = (line: string) => {
    const ts = new Date().toLocaleTimeString();
    setDiag((d) => {
      const next = [`${ts} ${line}`, ...d].slice(0, 20);
      AsyncStorage.setItem(DIAG_STORAGE_KEY, JSON.stringify(next)).catch(() => null);
      return next;
    });
  };

  useEffect(() => {
    AsyncStorage.getItem(DIAG_STORAGE_KEY)
      .then((raw) => {
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return;
        setDiag(parsed.filter((x) => typeof x === 'string').slice(0, 20));
      })
      .catch(() => null);
  }, []);

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
      mode: activeMode,
      guidedSession,
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

  const writeWorkoutToHealth = async (mode: SessionMode, durationSec: number, distanceM: number) => {
    if (Platform.OS !== 'ios') return;
    const mod = healthModuleRef.current;
    if (!mod?.writeWorkout) {
      logDiag('healthkit unavailable (native module missing)');
      return;
    }
    try {
      const res = await mod.writeWorkout({
        mode,
        durationSec: Math.max(1, Math.floor(durationSec)),
        distanceM: Math.max(0, distanceM),
        endedAtEpoch: Date.now() / 1000,
      });
      if (res?.ok) {
        logDiag('healthkit workout saved');
      } else {
        logDiag(`healthkit skipped: ${String(res?.reason || 'unknown')}`);
        if (res?.reason === 'permission_denied') {
          setMsg('Enable Apple Health permissions for Motion Coach to save workouts.');
        }
      }
    } catch (e: any) {
      logDiag(`healthkit write failed: ${String(e?.message || e || 'unknown')}`);
    }
  };

  const clearCueTimers = () => {
    for (const t of cueTimers.current) clearTimeout(t);
    cueTimers.current = [];
    cuePlanRef.current = [];
    cueCursorRef.current = 0;
    cueSessionIdRef.current = null;
    setScheduledCueCount(0);
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
    setScheduledCueCount(0);
  };

  const cancelAllCoachCueNotifications = async () => {
    try {
      const scheduled = await Notifications.getAllScheduledNotificationsAsync();
      await Promise.all(
        scheduled
          .filter((n: any) => {
            const data = (n?.content?.data || {}) as any;
            return data?.mclCue === true || String(data?.cueType || '').startsWith('cue_');
          })
          .map((n: any) => Notifications.cancelScheduledNotificationAsync(n.identifier))
      );
    } catch {
      // ignore cleanup errors
    }
  };

  const scheduleCueNotificationsFromElapsed = async (elapsedSec: number) => {
    await cancelCueNotifications();
    await cancelAllCoachCueNotifications();
    const now = Math.max(0, Math.floor(elapsedSec));
    const remaining = cuePlanRef.current.filter((c) => c.atSec > now);
    const ids: string[] = [];
    for (const c of remaining) {
      const delaySec = Math.max(1, Math.floor(c.atSec - now));
      try {
        const id = await Notifications.scheduleNotificationAsync({
          content: {
            title: 'Motion Coach',
            body: c.text,
            sound: 'default',
            data: { cueType: c.type, mclCue: true, sessionId: cueSessionIdRef.current || undefined },
            ...(Platform.OS === 'ios'
              ? { interruptionLevel: 'timeSensitive' as const }
              : {}),
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
    setScheduledCueCount(ids.length);
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

      // Play the same recorded cue sound whenever app is not backgrounded.
      if (appStateRef.current !== 'background') {
        playLocalCue(c.type).catch(() => null);
        Vibration.vibrate(120);
      }
      setLastCueFired(`${new Date().toLocaleTimeString()} ${c.type}`);
      setMsg(`🔊 ${c.text}`);
      logDiag(`cue: ${c.type}`);
      if (cueSessionIdRef.current) {
        sendEvent(cueSessionIdRef.current, c.type).catch(() => null);
      }
    }
  };

  const scheduleCues = async (sid: number) => {
    const basePlan = intervalPlan || { warmup: 5, run: 1, walk: 1.5, repeats: 8, cooldown: 5 };
    const plan = { ...basePlan, warmup: testWarmupMin };
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
    const firstRunAt = t;
    if (firstRunAt > 20) {
      cues.push({ atSec: firstRunAt - 20, text: 'First run starts in 20 seconds. Get ready.', type: 'cue_prerun' });
    }
    for (let i = 0; i < plan.repeats; i += 1) {
      cues.push({ atSec: t, text: `Run ${i + 1} of ${plan.repeats}. Start running now.`, type: 'cue_run' });
      t += plan.run * 60;
      if (i < plan.repeats - 1 && plan.walk > 0) {
        cues.push({ atSec: t, text: `Walk now`, type: 'cue_walk' });
        t += plan.walk * 60;
      }
    }
    cues.push({ atSec: t, text: `Cool-down walk`, type: 'cue_cooldown' });
    const half = Math.floor(t * 0.6);

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
    totalPlannedSecRef.current = t + (plan.cooldown * 60);
    cueCursorRef.current = 0;
    cueSessionIdRef.current = sid;
    logDiag(`cue plan loaded (${cuePlanRef.current.length} cues)`);
    await scheduleCueNotificationsFromElapsed(0);
    await startNativeCuePlayback(0);
  };

  const beginStartCountdown = (params: { mode: SessionMode; guided: boolean }) => {
    if (startedAt || countdownSec !== null) return;
    setPendingStart(params);
    setCountdownSec(START_COUNTDOWN_SEC);
    setMsg('');
  };

  useEffect(() => {
    if (countdownSec === null) return;
    if (countdownSec <= 0) {
      const pending = pendingStart;
      setCountdownSec(null);
      setPendingStart(null);
      if (pending) {
        startSessionFlow(pending).catch((e: any) => setMsg(e?.message || 'Start failed'));
      }
      return;
    }
    playLocalCue('cue_countdown_tick', { duck: false }).catch(() => null);
    Vibration.vibrate(40);
    const id = setTimeout(() => {
      setCountdownSec((prev) => (prev === null ? null : prev - 1));
    }, 1000);
    return () => clearTimeout(id);
  }, [countdownSec, pendingStart]);

  const startSessionFlow = async ({ mode, guided }: { mode: SessionMode; guided: boolean }) => {
    if (!(await requestLocation())) return;
    if (backgroundMode) {
      try {
        const bg = await Location.requestBackgroundPermissionsAsync();
        if (bg.status !== 'granted') {
          setMsg('Background location not granted. Continuing in foreground mode.');
        }
      } catch {
        // Continue in foreground mode.
      }
    }
    const issues = await evaluateReadiness();
    const blocking = issues.filter((i) => i.toLowerCase().includes('notification'));
    if (blocking.length) {
      setMsg(`Before starting: ${blocking.join('; ')}. Tap "Open Settings" below, then retry.`);
      return;
    }
    try {
      const s = await startSession(userId);
      setIsStopping(false);
      setSessionId(s.id);
      setStartedAt(Date.now());
      setActiveMode(mode);
      setGuidedSession(guided);
      setLastRunSummary(null);
      setCheckStage('none');
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
      await cancelAllCoachCueNotifications();
      await stopNativeCuePlayback();
      await startWatcher();
      await startBackgroundUpdates();
      logDiag(`session started (id ${s.id})`);
      setMsg(backgroundMode ? 'Session started. GPS + background tracking on.' : 'Session started. GPS tracking on.');
      await sendEvent(s.id, 'start');
      if (guided) {
        await scheduleCues(s.id);
      } else {
        totalPlannedSecRef.current = 0;
        await playLocalCue(mode === 'walk' ? 'cue_walk_start' : 'cue_run_start');
        Vibration.vibrate(120);
      }
      await startLiveActivity(s.id, 0, 0, false);
      await persistActive();
    } catch (e: any) {
      setMsg(e?.message || 'Start failed');
    }
  };

  const onStartWalk = () => beginStartCountdown({ mode: 'walk', guided: false });

  const onStartRun = () => {
    const hasGuidedPlan = !!intervalPlan && intervalPlan.repeats > 0 && intervalPlan.run > 0;
    if (!guidedCuesEnabled || !hasGuidedPlan) {
      beginStartCountdown({ mode: 'run', guided: false });
      return;
    }
    Alert.alert('Guided run today?', 'Do you want interval voice guidance for this run?', [
      { text: 'No', style: 'cancel', onPress: () => beginStartCountdown({ mode: 'run', guided: false }) },
      { text: 'Yes', onPress: () => beginStartCountdown({ mode: 'run', guided: true }) },
    ]);
  };

  const onPauseResume = async () => {
    if (isStopping) return;
    if (!sessionId) return;
    if (!isPaused) {
      setIsPaused(true);
      await cancelCueNotifications();
      await stopNativeCuePlayback();
      pauseStartedAtRef.current = Date.now();
      setMsg('Paused.');
      logDiag('paused');
      try {
        await sendEvent(sessionId, 'pause');
      } catch {}
      await updateLiveActivity(sessionId, seconds, distanceM, true);
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
    await updateLiveActivity(sessionId, seconds, distanceM, false);
    await scheduleCueNotificationsFromElapsed(seconds);
    await startNativeCuePlayback(seconds);
    await persistActive();
  };

  const onStop = async () => {
    if (isStopping) return;
    if (!sessionId) return;
    setIsStopping(true);
    try {
      watcherRef.current?.remove();
      clearCueTimers();
      await cancelCueNotifications();
      await cancelAllCoachCueNotifications();
      await stopNativeCuePlayback();
      await stopBackgroundUpdates();

      const merged = mergePoints(pointsRef.current, BG_POINTS);
      const mergedDistance = computeDistance(merged);
      const durationSec = Math.max(1, seconds);
      const route = merged
        .slice(0, 500)
        .map((p) => `${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`)
        .join(';');

      setDistanceM(mergedDistance);
      setRouteCoords(merged);
      logDiag(`stopped: ${Math.round(mergedDistance)}m in ${seconds}s, points=${merged.length}`);
      const stopPayload = { distance_m: Math.round(mergedDistance), duration_s: durationSec, route_polyline: route || undefined };
      try {
        await stopSession(sessionId, stopPayload.distance_m, stopPayload.duration_s, stopPayload.route_polyline);
      } catch {
        await enqueueAction('stop', sessionId, stopPayload);
        await refreshSyncStatus();
        logDiag('stop queued for sync');
      }
      await clearActiveSession();
      await endLiveActivity(sessionId, durationSec, mergedDistance);
      await writeWorkoutToHealth(activeMode, durationSec, mergedDistance);
      if (!guidedSession) {
        await playLocalCue(activeMode === 'walk' ? 'cue_walk_end' : 'cue_run_end');
        Vibration.vibrate(120);
      }
      setStartedAt(null);
      setGuidedSession(false);
      setIsPaused(false);
      setSeconds(0);
      setDistanceM(0);
      setLastCueFired('');
      setScheduledCueCount(0);
      setMsg('Run saved. Quick check-in.');
      setCheckStage('feel');
      setLastRunSummary({
        mode: activeMode,
        durationSec,
        distanceM: mergedDistance,
        endedAtMs: Date.now(),
      });
    } catch (e: any) {
      setMsg(e?.message || 'Stop failed');
    } finally {
      setIsStopping(false);
    }
  };

  const FEEL_MAP: Record<FeelValue, { effort: string; fatigue: string; pain: string; session_feel: string; note: string }> = {
    very_easy: { effort: 'easy', fatigue: 'fresh', pain: 'none', session_feel: 'too_easy', note: 'very_easy' },
    easy: { effort: 'moderate', fatigue: 'fresh', pain: 'none', session_feel: 'slight_progress', note: 'easy' },
    moderate: { effort: 'moderate', fatigue: 'heavy', pain: 'none', session_feel: 'about_right', note: 'moderate' },
    hard: { effort: 'hard', fatigue: 'heavy', pain: 'minor', session_feel: 'hard_repeat', note: 'hard' },
    very_hard: { effort: 'max', fatigue: 'very_heavy', pain: 'pain_form', session_feel: 'too_hard', note: 'very_hard' },
  };

  const submitFeelCheckin = async (feel: FeelValue) => {
    if (!sessionId) return;
    const mapped = FEEL_MAP[feel];
    const payload = {
      effort: mapped.effort,
      fatigue: mapped.fatigue,
      pain: mapped.pain,
      session_feel: mapped.session_feel,
      notes: mapped.note,
    };
    try {
      const res = await checkinSession(sessionId, payload);
      setCheckStage('done');
      setMsg('Check-in saved.');
      setLastRunSummary((prev) => (prev ? { ...prev, feel } : prev));
      setSessionId(null);
      setCheck({ session_feel: '' });
      await clearActiveSession();
    } catch (e: any) {
      try {
        await enqueueAction('checkin', sessionId, payload);
        await refreshSyncStatus();
        setCheckStage('done');
        setMsg('Check-in saved locally. Will sync when network is available.');
        setLastRunSummary((prev) => (prev ? { ...prev, feel } : prev));
        setSessionId(null);
        setCheck({ session_feel: '' });
      } catch {
        setMsg(e?.message || 'Check-in failed');
      }
    }
  };

  const region = useMemo(() => buildRegion(routeCoords), [routeCoords]);

  return (
    <ScrollView style={styles.wrap} contentContainerStyle={styles.wrapContent}>
      <View style={styles.card}>
        <View style={styles.runHeaderRow}>
          <Text style={styles.h1}>Run</Text>
          <Text style={styles.meta}>Sync: {syncState}{pendingSyncCount ? ` (${pendingSyncCount})` : ''}</Text>
        </View>

        <View style={styles.ringWrap}>
          <RingProgress
            progress={ringProgress}
            size={ringSize}
            stroke={ringStroke}
          />
          <Animated.View
            style={[
              styles.ringCenter,
              {
                transform: [{ scale: legAnim }],
                opacity: legAnim.interpolate({ inputRange: [0.86, 1], outputRange: [0.75, 1] }),
              },
            ]}
          >
            <Text style={styles.legLabel}>{legLabel}</Text>
            <Text style={styles.legTime}>{legRemaining}</Text>
            <Text style={styles.legHint}>{countdownSec !== null ? 'Get ready' : 'Current leg'}</Text>
          </Animated.View>
        </View>

        <View style={styles.metricRow}>
          <MetricItem label="Time in motion" value={elapsed} />
          <MetricItem label="Distance" value={distanceLabel} />
          <MetricItem label="Pace" value={pace} noDivider />
        </View>
        {__DEV__ ? <Text style={styles.meta}>Last cue: {lastCueFired || '-'} • Scheduled: {scheduledCueCount}</Text> : null}

        {!startedAt ? (
          <View style={styles.centerActionWrap}>
            <View style={styles.startRow}>
              <Pressable style={[styles.startSecondary, countdownSec !== null && styles.disabledBtn]} onPress={onStartWalk} disabled={countdownSec !== null}>
                <Text style={styles.startSecondaryText}>Start Walk</Text>
              </Pressable>
              <Pressable style={[styles.startPrimary, countdownSec !== null && styles.disabledBtn]} onPress={onStartRun} disabled={countdownSec !== null}>
                <Text style={styles.startPrimaryText}>Start Run</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.row}>
            <Pressable style={[styles.smallBtn, isStopping && styles.disabledBtn]} onPress={onPauseResume} disabled={isStopping}>
              <Text style={styles.smallBtnText}>{isPaused ? 'Resume' : 'Pause'}</Text>
            </Pressable>
            <Pressable style={[styles.stop, isStopping && styles.disabledBtn]} onPress={onStop} disabled={isStopping}>
              <Text style={styles.primaryText}>{isStopping ? 'Stopping...' : activeMode === 'walk' ? 'Stop Walk' : 'Stop Run'}</Text>
            </Pressable>
          </View>
        )}
      </View>

      {checkStage === 'feel' ? (
        <View style={styles.card}>
          <Text style={styles.h2}>How hard did that feel?</Text>
          <View style={styles.emojiRow}>
            {[
              { icon: '😄', value: 'very_easy' as const },
              { icon: '🙂', value: 'easy' as const },
              { icon: '😐', value: 'moderate' as const },
              { icon: '😮', value: 'hard' as const },
              { icon: '🥵', value: 'very_hard' as const },
            ].map((option) => (
              <Pressable
                key={option.value}
                style={[styles.emojiBtn, check.session_feel === option.value && styles.emojiBtnOn]}
                onPress={async () => {
                  setCheck({ session_feel: option.value });
                  await submitFeelCheckin(option.value);
                }}
              >
                <Text style={styles.emojiIcon}>{option.icon}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.scaleLegendRow}>
            <Text style={styles.scaleLegendText}>Easy</Text>
            <View style={styles.scaleLegendLine} />
            <Text style={styles.scaleLegendText}>Hard</Text>
          </View>
        </View>
      ) : null}

      {lastRunSummary && !startedAt ? (
        <View style={styles.card}>
          <Text style={styles.h2}>Last run summary</Text>
          <Text style={styles.summaryMeta}>
            {lastRunSummary.mode === 'walk' ? 'Walk' : 'Run'} · {new Date(lastRunSummary.endedAtMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          </Text>
          <View style={styles.metricRow}>
            <MetricItem label="Time in motion" value={formatDuration(lastRunSummary.durationSec)} />
            <MetricItem label="Distance" value={formatDistance(lastRunSummary.distanceM)} />
            <MetricItem label="Pace" value={formatPace(lastRunSummary.durationSec, lastRunSummary.distanceM)} noDivider />
          </View>
          <View style={styles.summaryFeelRow}>
            <Text style={styles.summaryFeelLabel}>Check-in</Text>
            <Text style={styles.summaryFeelValue}>{lastRunSummary.feel ? feelToEmoji(lastRunSummary.feel) : 'Pending'}</Text>
          </View>
        </View>
      ) : null}

      {region && routeCoords.length >= 2 ? (
        <View style={styles.mapCard}>
          <Text style={styles.h2}>Route Preview</Text>
          <MapView style={styles.map} initialRegion={region}>
            <Polyline
              coordinates={routeCoords.map((p) => ({ latitude: p.latitude, longitude: p.longitude }))}
              strokeWidth={4}
              strokeColor={theme.colors.accent}
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

      {msg ? <Text style={styles.msg}>{msg}</Text> : null}
    </ScrollView>
  );
}

function MetricItem({ label, value, noDivider }: { label: string; value: string; noDivider?: boolean }) {
  return (
    <View style={[styles.metricItem, noDivider && styles.metricItemLast]}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
        {value}
      </Text>
    </View>
  );
}

function formatDuration(totalSec: number) {
  const sec = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDistance(distanceM: number) {
  return distanceM < 1000 ? `${Math.round(distanceM)} m` : `${(distanceM / 1000).toFixed(2)} km`;
}

function formatPace(durationSec: number, distanceM: number) {
  if (distanceM <= 0 || durationSec <= 0) return '-';
  const secPerKm = Math.round(durationSec / (distanceM / 1000));
  const mm = Math.floor(secPerKm / 60);
  const ss = secPerKm % 60;
  return `${mm}:${String(ss).padStart(2, '0')}"/km`;
}

function feelToEmoji(feel: FeelValue) {
  const map: Record<FeelValue, string> = {
    very_easy: '😄',
    easy: '🙂',
    moderate: '😐',
    hard: '😮',
    very_hard: '🥵',
  };
  return map[feel];
}

function RingProgress({ progress, size, stroke }: { progress: number; size: number; stroke: number }) {
  const radius = (size - stroke) / 2;
  const c = 2 * Math.PI * radius;
  const offset = c * (1 - progress);
  return (
    <Svg width={size} height={size}>
      <Circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        stroke={theme.colors.border}
        strokeWidth={stroke}
        fill="none"
      />
      <Circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        stroke={theme.colors.accent}
        strokeWidth={stroke}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={`${c} ${c}`}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </Svg>
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
  const start = points[0];
  const latest = points[points.length - 1];
  const displacement = haversineMeters(start.latitude, start.longitude, latest.latitude, latest.longitude);
  const traveled = computeDistance(points);
  if (traveled < 500) return false;
  const ratio = displacement / Math.max(1, traveled);
  // Loop/oval paths usually have low displacement compared to distance traveled.
  return ratio >= 0.22;
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

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  wrapContent: { gap: 12, paddingBottom: 24 },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: 14,
    borderWidth: 1,
    borderColor: theme.colors.border,
    gap: 8,
    ...shadow,
  },
  mapCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    gap: 8,
    ...shadow,
  },
  map: { height: 220, borderRadius: theme.radius.md },
  h1: { fontSize: 20, fontWeight: '800', color: theme.colors.text },
  h2: { fontSize: 16, fontWeight: '700', color: theme.colors.text },
  p: { color: theme.colors.text },
  runHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  ringWrap: { alignSelf: 'center', marginTop: 2, marginBottom: 4 },
  ringCenter: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  legLabel: { color: theme.colors.textMuted, fontWeight: '700', fontSize: 14 },
  legTime: { color: theme.colors.text, fontSize: 52, fontWeight: '800', letterSpacing: -1 },
  legHint: { color: theme.colors.textMuted, fontSize: 12, fontWeight: '600', letterSpacing: 0.2 },
  metricRow: {
    marginTop: -2,
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    overflow: 'hidden',
    backgroundColor: theme.colors.surfaceAlt,
  },
  metricItem: { flex: 1, paddingVertical: 10, paddingHorizontal: 8, alignItems: 'center', borderRightWidth: 1, borderColor: theme.colors.border },
  metricItemLast: { borderRightWidth: 0 },
  metricLabel: { color: theme.colors.textMuted, fontSize: 11, fontWeight: '700' },
  metricValue: { color: theme.colors.text, fontSize: 16, fontWeight: '800', marginTop: 2, textAlign: 'center' },
  centerActionWrap: { alignItems: 'center', marginTop: 2 },
  startRow: { flexDirection: 'row', gap: 10, width: '100%' },
  startPrimary: {
    flex: 1,
    backgroundColor: theme.colors.accent,
    borderRadius: 999,
    paddingVertical: 15,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow,
  },
  startSecondary: {
    flex: 1,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: 999,
    paddingVertical: 15,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  startPrimaryText: { color: theme.colors.accentText, fontWeight: '800', fontSize: 18 },
  startSecondaryText: { color: theme.colors.text, fontWeight: '800', fontSize: 18 },
  primary: {
    flex: 1,
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radius.md,
    padding: 12,
    alignItems: 'center',
  },
  stop: {
    flex: 1,
    backgroundColor: theme.colors.brandOrange,
    borderRadius: theme.radius.md,
    padding: 12,
    alignItems: 'center',
  },
  toggleOn: { backgroundColor: theme.colors.accentSoft, borderColor: theme.colors.accent },
  disabledBtn: { opacity: 0.6 },
  primaryText: { color: theme.colors.accentText, fontWeight: '700' },
  emojiRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  emojiBtn: {
    flex: 1,
    minHeight: 78,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 8,
    paddingVertical: 10,
    gap: 4,
  },
  emojiBtnOn: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accentSoft },
  emojiIcon: { fontSize: 24 },
  scaleLegendRow: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    justifyContent: 'center',
  },
  scaleLegendText: { color: theme.colors.textMuted, fontSize: 12, fontWeight: '700' },
  scaleLegendLine: {
    flex: 1,
    maxWidth: 140,
    height: 2,
    borderRadius: 999,
    backgroundColor: theme.colors.border,
  },
  row: { flexDirection: 'row', gap: 8 },
  smallBtn: {
    flex: 1,
    padding: 10,
    alignItems: 'center',
    borderRadius: 8,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  smallBtnText: { fontWeight: '700', color: theme.colors.text },
  settingChip: {
    minHeight: 38,
    borderRadius: theme.radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  settingChipOn: { backgroundColor: theme.colors.accentSoft, borderColor: theme.colors.accent },
  settingChipText: { color: theme.colors.text, fontWeight: '700', fontSize: 12 },
  settingChipTextOn: { color: theme.colors.accent, fontWeight: '800' },
  msg: { color: theme.colors.text },
  meta: { color: theme.colors.textMuted, fontSize: 12 },
  syncBtn: {
    backgroundColor: theme.colors.accentSoft,
    borderRadius: 8,
    paddingVertical: 9,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#b8d8f3',
  },
  syncBtnText: { color: '#0f4e7f', fontWeight: '700', fontSize: 12 },
  diagCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    gap: 4,
    ...shadow,
  },
  diagLine: { color: theme.colors.textMuted, fontSize: 12 },
  summaryMeta: { color: theme.colors.textMuted, fontSize: 13, fontWeight: '600' },
  summaryFeelRow: {
    marginTop: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
  },
  summaryFeelLabel: { color: theme.colors.textMuted, fontSize: 13, fontWeight: '700' },
  summaryFeelValue: { color: theme.colors.text, fontSize: 24, fontWeight: '700' },
});
