import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { getProgress, MobileProgress } from '../lib/api';

export default function ProgressScreen({ userId }: { userId: number }) {
  const [data, setData] = useState<MobileProgress | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setErr('');
    try {
      setData(await getProgress(userId));
    } catch (e: any) {
      setData(null);
      setErr(e?.message || 'Failed to load progress');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [userId]);

  return (
    <View style={styles.wrap}>
      <Pressable onPress={load} style={styles.refresh}>
        <Text style={styles.refreshText}>{loading ? 'Loading...' : 'Refresh Progress'}</Text>
      </Pressable>

      {err ? <Text style={styles.err}>{err}</Text> : null}

      {data ? (
        <View style={styles.card}>
          <Stat label="This week motion" value={`${data.week_motion_min} min`} />
          <Stat label="This week distance" value={`${data.week_distance_km} km`} />
          <Stat label="Total distance" value={`${data.total_distance_km} km`} />
          <Stat label="Run streak" value={`${data.run_streak_days} day(s)`} />
          <Text style={styles.meta}>Week starts: {data.week_start}</Text>
        </View>
      ) : (
        <Text style={styles.p}>No progress loaded.</Text>
      )}
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statRow}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12 },
  refresh: { backgroundColor: '#6b8f41', borderRadius: 10, padding: 12, alignItems: 'center' },
  refreshText: { color: '#fff', fontWeight: '700' },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#dae6ce', gap: 10 },
  statRow: { flexDirection: 'row', justifyContent: 'space-between' },
  statLabel: { color: '#4b6143' },
  statValue: { fontWeight: '700', color: '#1c2a1b' },
  meta: { color: '#5a6f4f', fontSize: 12 },
  p: { color: '#203020' },
  err: { color: '#a32626' },
});
