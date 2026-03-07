import React, { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View, Pressable } from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';
import { deleteHistoryRun, getHistory, MobileHistoryItem } from '../lib/api';
import { shadow, theme } from '../ui/theme';

export default function HistoryScreen({ userId }: { userId: number }) {
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
    load();
  }, [userId]);

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
  deleting,
  onDelete,
}: {
  it: MobileHistoryItem;
  deleting: boolean;
  onDelete: (runId: number) => Promise<void> | void;
}) {
  const km = (it.distance_m / 1000).toFixed(2);
  const min = (it.duration_s / 60).toFixed(1);
  const title = formatStartedAtLocal(it.started_at);
  const points = parsePolyline(it.route_polyline || '');
  const region = buildRegion(points);

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
      <Text style={styles.p}>{km} km • {min} min • {it.pace_min_km || '-'} min/km</Text>
      <Text style={styles.meta}>source: {it.source}</Text>
      {it.session_feel ? (
        <Text style={styles.meta}>
          check-in: {feelToEmoji(it.session_feel)} {feelToLabel(it.session_feel)}
        </Text>
      ) : null}

      {region && points.length >= 2 ? (
        <MapView style={styles.map} initialRegion={region} scrollEnabled={false} zoomEnabled={false}>
          <Polyline
            coordinates={points.map((p) => ({ latitude: p.latitude, longitude: p.longitude }))}
            strokeWidth={3}
            strokeColor="#5a8f2f"
          />
          <Marker coordinate={{ latitude: points[0].latitude, longitude: points[0].longitude }} title="Start" />
          <Marker
            coordinate={{ latitude: points[points.length - 1].latitude, longitude: points[points.length - 1].longitude }}
            title="Finish"
          />
        </MapView>
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
  if (!polyline) return [] as Array<{ latitude: number; longitude: number }>;
  const out: Array<{ latitude: number; longitude: number }> = [];
  for (const pair of polyline.split(';')) {
    const [a, b] = pair.split(',');
    const lat = Number(a);
    const lon = Number(b);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      out.push({ latitude: lat, longitude: lon });
    }
  }
  return out;
}

function buildRegion(points: Array<{ latitude: number; longitude: number }>) {
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
    borderColor: '#d6dbe4',
    backgroundColor: '#f3f6fa',
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteBtnDisabled: { opacity: 0.65 },
  trashIcon: { color: '#7f8897', fontSize: 14, lineHeight: 14 },
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
  map: { height: 140, borderRadius: 8, marginTop: 4 },
  empty: { color: theme.colors.textMuted },
  err: { color: theme.colors.danger },
});
