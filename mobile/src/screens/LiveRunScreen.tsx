import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as Location from 'expo-location';
import * as Speech from 'expo-speech';
import * as TaskManager from 'expo-task-manager';
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

type CheckStage = 'none' | 'effort' | 'fatigue' | 'pain' | 'feel' | 'done';

type Coord = { latitude: number; longitude: number; ts: number };

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

export default function LiveRunScreen({ userId }: { userId: number }) {
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [distanceM, setDistanceM] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [backgroundMode, setBackgroundMode] = useState(true);
  const [guidedCuesEnabled, setGuidedCuesEnabled] = useState(true);
  const [msg, setMsg] = useState('');
  const [checkStage, setCheckStage] = useState<CheckStage>('none');
  const [check, setCheck] = useState({ effort: '', fatigue: '', pain: '' });
  const [routeCoords, setRouteCoords] = useState<Coord[]>([]);
  const [intervalPlan, setIntervalPlan] = useState<{ warmup: number; run: number; walk: number; repeats: number; cooldown: number } | null>(null);
  const [diag, setDiag] = useState<string[]>([]);
  const [syncState, setSyncState] = useState<'synced' | 'syncing' | 'pending'>('synced');
  const [pendingSyncCount, setPendingSyncCount] = useState(0);

  const watcherRef = useRef<Location.LocationSubscription | null>(null);
  const pointsRef = useRef<Coord[]>([]);
  const cueTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const pauseAccumRef = useRef<number>(0);
  const pauseStartedAtRef = useRef<number | null>(null);

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
    if (!startedAt || isPaused) return;
    const id = setInterval(() => {
      const paused = pauseAccumRef.current;
      setSeconds(Math.max(0, Math.floor((Date.now() - startedAt - paused) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [startedAt, isPaused]);

  useEffect(() => {
    return () => {
      watcherRef.current?.remove();
      clearCueTimers();
      stopBackgroundUpdates();
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

  const elapsed = useMemo(() => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`, [seconds]);
  const distanceKm = useMemo(() => (distanceM / 1000).toFixed(2), [distanceM]);
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
        };
        const prev = pointsRef.current[pointsRef.current.length - 1];
        pointsRef.current.push(p);
        setRouteCoords([...pointsRef.current]);
        if (prev) {
          const delta = haversineMeters(prev.latitude, prev.longitude, p.latitude, p.longitude);
          if (delta > 1 && delta < 100) {
            setDistanceM((d) => d + delta);
          }
        }
      }
    );
  };

  const speak = (text: string) => {
    Speech.stop();
    Speech.speak(text, { rate: 0.95, pitch: 1.0 });
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
  };

  const scheduleCues = async (sid: number) => {
    const plan = intervalPlan || { warmup: 5, run: 1, walk: 1.5, repeats: 8, cooldown: 5 };
    const cues: Array<{ atSec: number; text: string; type: string }> = [];
    let t = 0;
    cues.push({ atSec: t, text: `Warm-up walk for ${plan.warmup} minutes`, type: 'cue_warmup' });
    t += plan.warmup * 60;
    for (let i = 0; i < plan.repeats; i += 1) {
      cues.push({ atSec: t, text: `Run now`, type: 'cue_run' });
      t += plan.run * 60;
      if (i < plan.repeats - 1 && plan.walk > 0) {
        cues.push({ atSec: t, text: `Walk now`, type: 'cue_walk' });
        t += plan.walk * 60;
      }
    }
    cues.push({ atSec: t, text: `Cool-down walk`, type: 'cue_cooldown' });
    const half = Math.floor(t / 2);
    cues.push({ atSec: half, text: 'Halfway point. Turn around now.', type: 'cue_halfway' });

    for (const c of cues) {
      const timer = setTimeout(async () => {
        speak(c.text);
        setMsg(`🔊 ${c.text}`);
        logDiag(`cue: ${c.type}`);
        try {
          await sendEvent(sid, c.type);
        } catch {
          // do not break guided flow
        }
      }, c.atSec * 1000);
      cueTimers.current.push(timer);
    }
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
      pointsRef.current = [];
      BG_POINTS = [];
      setRouteCoords([]);
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
    await persistActive();
  };

  const onStop = async () => {
    if (!sessionId) return;
    try {
      watcherRef.current?.remove();
      clearCueTimers();
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
      setMsg('Run saved. Quick check-in: effort 1-10');
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
      setCheckStage('pain');
      return;
    }
    if (checkStage === 'pain') {
      setCheck((x) => ({ ...x, pain: value }));
      setCheckStage('feel');
    }
  };

  const submitFeel = async (session_feel: string) => {
    if (!sessionId) return;
    const payload = {
      effort: scoreToEffort(Number(check.effort)),
      fatigue: scoreToFatigue(Number(check.fatigue)),
      pain: scoreToPain(Number(check.pain)),
      session_feel,
      notes: `scores effort=${check.effort}, fatigue=${check.fatigue}, pain=${check.pain}`,
    };
    try {
      const res = await checkinSession(sessionId, payload);
      setCheckStage('done');
      setMsg(res.actions_applied?.length ? `Saved. ${res.actions_applied.join(' ')}` : 'Saved. No changes needed.');
      setSessionId(null);
      setCheck({ effort: '', fatigue: '', pain: '' });
      await clearActiveSession();
    } catch (e: any) {
      try {
        await enqueueAction('checkin', sessionId, payload);
        await refreshSyncStatus();
        setCheckStage('done');
        setMsg('Check-in saved locally. Will sync when network is available.');
        setSessionId(null);
        setCheck({ effort: '', fatigue: '', pain: '' });
      } catch {
        setMsg(e?.message || 'Check-in failed');
      }
    }
  };

  const region = useMemo(() => buildRegion(routeCoords), [routeCoords]);

  return (
    <View style={styles.wrap}>
      <View style={styles.card}>
        <Text style={styles.h1}>Live Run</Text>
        <Text style={styles.meta}>Sync: {syncState}{pendingSyncCount ? ` (${pendingSyncCount} pending)` : ''}</Text>
        <Text style={styles.p}>Elapsed: {elapsed}</Text>
        <Text style={styles.p}>Distance: {distanceKm} km</Text>
        <Text style={styles.p}>Pace: {pace}</Text>

        {!startedAt ? (
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
            <Pressable style={styles.primary} onPress={onStart}>
              <Text style={styles.primaryText}>Start Run</Text>
            </Pressable>
          </View>
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
            {checkStage === 'fatigue' && 'Fatigue now?'}
            {checkStage === 'pain' && 'Pain now?'}
            {checkStage === 'feel' && 'Session feel?'}
          </Text>
          {checkStage === 'feel' ? (
            <View style={styles.row}>
              <Pressable style={styles.smallBtn} onPress={() => submitFeel('too_easy')}><Text>Too Easy</Text></Pressable>
              <Pressable style={styles.smallBtn} onPress={() => submitFeel('about_right')}><Text>About Right</Text></Pressable>
              <Pressable style={styles.smallBtn} onPress={() => submitFeel('too_hard')}><Text>Too Hard</Text></Pressable>
            </View>
          ) : (
            <View style={styles.rowWrap}>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                <Pressable key={n} style={styles.scoreBtn} onPress={() => pushScore(String(n))}>
                  <Text>{n}</Text>
                </Pressable>
              ))}
            </View>
          )}
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
    const d = haversineMeters(last.latitude, last.longitude, p.latitude, p.longitude);
    if (d >= 1) {
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
    d += haversineMeters(points[i - 1].latitude, points[i - 1].longitude, points[i].latitude, points[i].longitude);
  }
  return d;
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

function scoreToPain(score: number): string {
  if (score >= 7) return 'pain_form';
  if (score >= 4) return 'minor';
  return 'none';
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
