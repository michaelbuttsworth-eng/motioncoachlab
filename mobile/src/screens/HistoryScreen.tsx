import React, { useEffect, useState } from 'react';
import { Alert, Linking, ScrollView, StyleSheet, Text, View, Pressable } from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';
import { deleteHistoryRun, getHistory, MobileHistoryItem } from '../lib/api';
import { formatDistance, formatPace, splitDistanceM, UnitSystem } from '../lib/units';
import { shadow, theme } from '../ui/theme';

export default function HistoryScreen({ userId, isActive = true, unitSystem }: { userId: number; isActive?: boolean; unitSystem: UnitSystem }) {
  const [items, setItems] = useState<MobileHistoryItem[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [deletingRunId, setDeletingRunId] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    setErr('');
    try {
      const res = await getHistory(userId);
      setItems(res.items || []);
    } catch (e: any) {
      setItems([]);
      setErr(e?.message || 'Failed to load history');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isActive) return;
    load();
  }, [userId, isActive]);

  const recent = items.slice(0, 5);
  const earlier = items.slice(5);

  return (
    <View style={styles.wrap}>
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>History</Text>
        <Text style={styles.heroTitle}>Session Log</Text>
      </View>
      <Pressable onPress={load} style={styles.refresh}>
        <Text style={styles.refreshText}>{loading ? 'Loading...' : 'Refresh Sessions'}</Text>
      </Pressable>
      {err ? <Text style={styles.err}>{err}</Text> : null}

      <ScrollView contentContainerStyle={styles.list}>
        {recent.length ? <Text style={styles.sectionTitle}>Recent</Text> : null}
        {recent.map((it) => (
          <HistoryCard
            key={it.run_id}
            it={it}
            unitSystem={unitSystem}
            deleting={deletingRunId === it.run_id}
            onDelete={async (runId) => {
              if (deletingRunId) return;
              Alert.alert(
                'Delete workout?',
                'This will permanently remove this workout and related records from app data. This cannot be undone.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: async () => {
                      try {
                        setDeletingRunId(runId);
                        await deleteHistoryRun(userId, runId);
                        await load();
                      } catch (e: any) {
                        setErr(e?.message || 'Failed to delete workout');
                      } finally {
                        setDeletingRunId(null);
                      }
                    },
                  },
                ]
              );
            }}
          />
        ))}

        {earlier.length ? (
          <View style={styles.olderWrap}>
            <Pressable style={styles.secondaryBtn} onPress={() => setShowAll((v) => !v)}>
              <Text style={styles.secondaryBtnText}>
                {showAll ? 'Hide Earlier Sessions' : `Show Earlier Sessions (${earlier.length})`}
              </Text>
            </Pressable>
            {showAll ? (
              <View style={styles.olderList}>
                <Text style={styles.sectionTitle}>Earlier</Text>
                {earlier.map((it) => (
                  <HistoryCard
                    key={it.run_id}
                    it={it}
                    unitSystem={unitSystem}
                    deleting={deletingRunId === it.run_id}
                    onDelete={async (runId) => {
                      if (deletingRunId) return;
                      Alert.alert(
                        'Delete workout?',
                        'This will permanently remove this workout and related records from app data. This cannot be undone.',
                        [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: 'Delete',
                            style: 'destructive',
                            onPress: async () => {
                              try {
                                setDeletingRunId(runId);
                                await deleteHistoryRun(userId, runId);
                                await load();
                              } catch (e: any) {
                                setErr(e?.message || 'Failed to delete workout');
                              } finally {
                                setDeletingRunId(null);
                              }
                            },
                          },
                        ]
                      );
                    }}
                  />
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        {!items.length && !loading ? <Text style={styles.empty}>No runs yet.</Text> : null}
      </ScrollView>
    </View>
  );
}

function HistoryCard({
  it,
  unitSystem,
  deleting,
  onDelete,
}: {
  it: MobileHistoryItem;
  unitSystem: UnitSystem;
  deleting: boolean;
  onDelete: (runId: number) => Promise<void> | void;
}) {
  const noteText = String(it.notes || '').trim();
  const points = parsePolyline(it.route_polyline || '');
  const splits = buildSplits(points, Math.max(1, it.duration_s), unitSystem);
  const hasDetails = noteText.length > 0 || points.length >= 2 || splits.length > 0;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const min = (it.duration_s / 60).toFixed(1);
  const title = formatStartedAtLocal(it.started_at);
  const region = buildRegion(points);

  const openAppleMaps = async () => {
    if (!points.length) return;
    const start = points[0];
    const end = points[points.length - 1];
    const samePoint = start.latitude === end.latitude && start.longitude === end.longitude;
    const url = samePoint
      ? `http://maps.apple.com/?q=${start.latitude},${start.longitude}`
      : `http://maps.apple.com/?saddr=${start.latitude},${start.longitude}&daddr=${end.latitude},${end.longitude}&dirflg=w`;
    try {
      await Linking.openURL(url);
    } catch {
      // ignore open-url failures on device without Apple Maps
    }
  };

  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.h1}>{title}</Text>
        <Pressable
          style={[styles.trashIconBtn, deleting && styles.deleteBtnDisabled]}
          onPress={() => onDelete(it.run_id)}
          disabled={deleting}
          accessibilityRole="button"
          accessibilityLabel={deleting ? 'Deleting workout' : 'Delete workout'}
        >
          <Text style={styles.trashIcon}>{deleting ? '…' : '🗑'}</Text>
        </Pressable>
      </View>
      <Text style={styles.p}>{formatDistance(it.distance_m, unitSystem)} • {min} min • {formatPace(it.duration_s, it.distance_m, unitSystem)}</Text>
      <Text style={styles.meta}>Tracked via GPS</Text>
      {it.session_feel ? (
        <Text style={styles.meta}>
          check-in: {feelToEmoji(it.session_feel)} {feelToLabel(it.session_feel)}
        </Text>
      ) : null}

      {hasDetails ? (
        <>
          <Pressable style={styles.routeToggle} onPress={() => setDetailsOpen((v) => !v)}>
            <Text style={styles.routeToggleText}>{detailsOpen ? 'Hide details' : 'Show details'}</Text>
          </Pressable>
          {detailsOpen ? (
            <View style={styles.detailsWrap}>
              {noteText ? (
                <View style={styles.detailBlock}>
                  <Text style={styles.detailTitle}>Notes</Text>
                  <Text style={styles.detailBody}>{noteText}</Text>
                </View>
              ) : null}
              {splits.length ? (
                <View style={styles.detailBlock}>
                  <Text style={styles.detailTitle}>Splits</Text>
                  {splits.map((s) => (
                    <View key={s.label} style={styles.splitRow}>
                      <Text style={styles.splitLabel}>{s.label}</Text>
                      <Text style={styles.splitValue}>{s.time} • {s.pace}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
              {region && points.length >= 2 ? (
                <View style={styles.detailBlock}>
                  <Text style={styles.detailTitle}>Route</Text>
                  <Pressable onPress={openAppleMaps}>
                    <MapView style={styles.map} initialRegion={region} scrollEnabled={false} zoomEnabled={false}>
                      <Polyline
                        coordinates={points.map((p) => ({ latitude: p.latitude, longitude: p.longitude }))}
                        strokeWidth={3}
                        strokeColor={theme.colors.accentAlt}
                      />
                      <Marker coordinate={{ latitude: points[0].latitude, longitude: points[0].longitude }} title="Start" />
                      <Marker
                        coordinate={{ latitude: points[points.length - 1].latitude, longitude: points[points.length - 1].longitude }}
                        title="Finish"
                      />
                    </MapView>
                    <Text style={styles.mapHint}>Tap map to open in Apple Maps</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function parseStartedAt(value: string): Date {
  // Backend timestamps can be timezone-naive UTC. Treat naive values as UTC.
  const hasTimezone = /(?:Z|[+\-]\d{2}:\d{2})$/.test(value);
  return hasTimezone ? new Date(value) : new Date(`${value}Z`);
}

function formatStartedAtLocal(value: string): string {
  const d = parseStartedAt(value);
  return d.toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function feelToEmoji(feel: string): string {
  const key = String(feel || '').toLowerCase();
  if (key === 'too_easy' || key === 'very_easy') return '😄';
  if (key === 'slight_progress' || key === 'easy') return '🙂';
  if (key === 'about_right' || key === 'moderate') return '😐';
  if (key === 'hard_repeat' || key === 'hard') return '😮';
  if (key === 'too_hard' || key === 'very_hard') return '🥵';
  return '😐';
}

function feelToLabel(feel: string): string {
  const key = String(feel || '').toLowerCase();
  if (key === 'too_easy' || key === 'very_easy') return 'very easy';
  if (key === 'slight_progress' || key === 'easy') return 'easy';
  if (key === 'about_right' || key === 'moderate') return 'moderate';
  if (key === 'hard_repeat' || key === 'hard') return 'hard';
  if (key === 'too_hard' || key === 'very_hard') return 'very hard';
  return key.replace(/_/g, ' ');
}

function parsePolyline(polyline: string) {
  if (!polyline) return [] as Array<{ latitude: number; longitude: number; ts?: number }>;
  const out: Array<{ latitude: number; longitude: number; ts?: number }> = [];
  for (const pair of polyline.split(';')) {
    const [a, b, c] = pair.split(',');
    const lat = Number(a);
    const lon = Number(b);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const ts = Number(c);
      out.push({ latitude: lat, longitude: lon, ts: Number.isFinite(ts) ? ts : undefined });
    }
  }
  return out;
}

function buildRegion(points: Array<{ latitude: number; longitude: number; ts?: number }>) {
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

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatSplitTime(sec: number) {
  const safe = Math.max(0, Math.round(sec));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function buildSplits(
  points: Array<{ latitude: number; longitude: number; ts?: number }>,
  totalDurationSec: number,
  unitSystem: UnitSystem
): Array<{ label: string; time: string; pace: string }> {
  const splitM = splitDistanceM(unitSystem);
  if (points.length < 2) return [];
  const segs: number[] = [];
  let totalM = 0;
  for (let i = 1; i < points.length; i += 1) {
    const d = haversineMeters(points[i - 1].latitude, points[i - 1].longitude, points[i].latitude, points[i].longitude);
    segs.push(d);
    totalM += d;
  }
  if (totalM < splitM * 0.5) return [];
  const splitCount = Math.floor(totalM / splitM);
  let prevDist = 0;
  let prevElapsed = 0;
  const out: Array<{ label: string; time: string; pace: string }> = [];
  for (let i = 1; i <= splitCount; i += 1) {
    const target = i * splitM;
    const elapsed = Math.round((target / totalM) * totalDurationSec);
    const splitDur = Math.max(1, elapsed - prevElapsed);
    const splitDist = target - prevDist;
    out.push({
      label: `${i}. ${unitSystem === 'imperial' ? '1 mi' : '1 km'}`,
      time: formatSplitTime(splitDur),
      pace: formatPace(splitDur, splitDist, unitSystem),
    });
    prevDist = target;
    prevElapsed = elapsed;
  }
  const remDist = totalM - prevDist;
  if (remDist >= splitM * 0.25) {
    const remElapsed = Math.max(1, totalDurationSec - prevElapsed);
    const remLabel = `${splitCount + 1}. Last ${formatDistance(remDist, unitSystem)}`;
    out.push({
      label: remLabel,
      time: formatSplitTime(remElapsed),
      pace: formatPace(remElapsed, remDist, unitSystem),
    });
  }
  return out;
}

const styles = StyleSheet.create({
  wrap: { flex: 1, gap: 10 },
  hero: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 14,
    gap: 4,
    ...shadow,
  },
  eyebrow: { color: theme.colors.textMuted, fontWeight: '700', fontSize: 12, letterSpacing: 0.3 },
  heroTitle: { fontWeight: '800', fontSize: 20, color: theme.colors.text },
  heroText: { color: theme.colors.textMuted },
  refresh: { backgroundColor: theme.colors.accent, borderRadius: theme.radius.md, padding: 12, alignItems: 'center' },
  refreshText: { color: theme.colors.accentText, fontWeight: '700' },
  sectionTitle: { color: theme.colors.textMuted, fontSize: 12, fontWeight: '800', letterSpacing: 0.4, textTransform: 'uppercase' },
  list: { gap: 10, paddingBottom: 32 },
  olderWrap: { gap: 8 },
  olderList: { gap: 10 },
  secondaryBtn: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.md,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  secondaryBtnText: { color: theme.colors.text, fontWeight: '700' },
  trashIconBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteBtnDisabled: { opacity: 0.65 },
  trashIcon: { color: theme.colors.textMuted, fontSize: 14, lineHeight: 14 },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    gap: 6,
    ...shadow,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  h1: { fontSize: 14, fontWeight: '700', color: theme.colors.text },
  p: { color: theme.colors.text },
  meta: { color: theme.colors.textMuted, fontSize: 12 },
  notesWrap: { gap: 4, alignItems: 'flex-start' },
  detailsWrap: { gap: 8, marginTop: 2 },
  detailBlock: {
    gap: 6,
    padding: 8,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  detailTitle: { color: theme.colors.text, fontSize: 12, fontWeight: '800' },
  detailBody: { color: theme.colors.textMuted, fontSize: 12, lineHeight: 18 },
  splitRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, paddingVertical: 2 },
  splitLabel: { color: theme.colors.textMuted, fontSize: 12 },
  splitValue: { color: theme.colors.text, fontSize: 12, fontWeight: '600' },
  map: { height: 140, borderRadius: 8 },
  routeToggle: {
    marginTop: 2,
    alignSelf: 'flex-start',
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  routeToggleText: { color: theme.colors.text, fontWeight: '700', fontSize: 12 },
  mapHint: { color: theme.colors.textMuted, fontSize: 11, marginTop: 6 },
  empty: { color: theme.colors.textMuted },
  err: { color: theme.colors.danger },
});
