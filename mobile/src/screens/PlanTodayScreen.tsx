import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { bootstrapProfile, generatePlan, getPlanToday, MobilePlanToday } from '../lib/api';

export default function PlanTodayScreen({ userId }: { userId: number }) {
  const [data, setData] = useState<MobilePlanToday | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setErr('');
    try {
      const res = await getPlanToday(userId);
      setData(res);
    } catch (e: any) {
      const msg = String(e?.message || '');
      if (msg.includes('404')) {
        try {
          await generatePlan(userId, 16);
          const res = await getPlanToday(userId);
          setData(res);
          setErr('');
          return;
        } catch (retryErr: any) {
          setData(null);
          setErr(retryErr?.message || 'No plan available yet.');
          return;
        }
      }
      if (msg.includes('400') && msg.toLowerCase().includes('profile required')) {
        try {
          await bootstrapProfile(userId);
          await generatePlan(userId, 16);
          const res = await getPlanToday(userId);
          setData(res);
          setErr('');
          return;
        } catch (retryErr: any) {
          setData(null);
          setErr(retryErr?.message || 'Profile setup failed.');
          return;
        }
      }
      setData(null);
      setErr(msg || 'Failed to load plan');
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
        <Text style={styles.refreshText}>{loading ? 'Loading...' : 'Refresh Plan'}</Text>
      </Pressable>

      {err ? <Text style={styles.err}>{err}</Text> : null}

      {data ? (
        <View style={styles.card}>
          <Text style={styles.h1}>Today: {data.session_type}</Text>
          <Text style={styles.p}>Planned distance: {data.planned_km} km</Text>
          {data.interval ? (
            <Text style={styles.p}>
              Guided: {String(data.interval.run || '')} min run / {String(data.interval.walk || '')} min walk,
              repeats {String(data.interval.repeats || '')}
            </Text>
          ) : null}
          {data.notes ? <Text style={styles.notes}>{data.notes}</Text> : null}
        </View>
      ) : (
        <Text style={styles.p}>No plan loaded.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12 },
  refresh: { backgroundColor: '#6b8f41', borderRadius: 10, padding: 12, alignItems: 'center' },
  refreshText: { color: '#fff', fontWeight: '700' },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#dae6ce', gap: 8 },
  h1: { fontWeight: '700', fontSize: 18, color: '#1f2d1f' },
  p: { color: '#203020' },
  notes: { color: '#48653c', fontSize: 12 },
  err: { color: '#a32626' },
});
