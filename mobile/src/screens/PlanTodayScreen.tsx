import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { bootstrapProfile, generatePlan, getPlanToday, getPlanUpcoming, MobilePlanToday, MobileUpcomingWorkout } from '../lib/api';
import { shadow, theme } from '../ui/theme';

export default function PlanTodayScreen({ userId }: { userId: number }) {
  const [data, setData] = useState<MobilePlanToday | null>(null);
  const [upcoming, setUpcoming] = useState<MobileUpcomingWorkout[]>([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [expandedDay, setExpandedDay] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setErr('');
    try {
      const res = await getPlanToday(userId);
      setData(res);
      try {
        const upcomingRes = await getPlanUpcoming(userId, 8, false);
        const todayIso = String(res.day);
        setUpcoming((upcomingRes.items || []).filter((w) => String(w.day) > todayIso));
      } catch {
        setUpcoming([]);
      }
    } catch (e: any) {
      const msg = String(e?.message || '');
      if (msg.includes('404')) {
        try {
          await generatePlan(userId, 16);
          const [res, upcomingRes] = await Promise.all([
            getPlanToday(userId),
            getPlanUpcoming(userId, 8, false).catch(() => ({ user_id: userId, items: [] })),
          ]);
          setData(res);
          const todayIso = String(res.day);
          setUpcoming((upcomingRes.items || []).filter((w) => String(w.day) > todayIso));
          setErr('');
          return;
        } catch (retryErr: any) {
          setData(null);
          setUpcoming([]);
          setErr(retryErr?.message || 'No plan available yet.');
          return;
        }
      }
      if (msg.includes('400') && msg.toLowerCase().includes('profile required')) {
        try {
          await bootstrapProfile(userId);
          await generatePlan(userId, 16);
          const [res, upcomingRes] = await Promise.all([
            getPlanToday(userId),
            getPlanUpcoming(userId, 8, false),
          ]);
          setData(res);
          const todayIso = String(res.day);
          setUpcoming((upcomingRes.items || []).filter((w) => String(w.day) > todayIso));
          setErr('');
          return;
        } catch (retryErr: any) {
          setData(null);
          setUpcoming([]);
          setErr(retryErr?.message || 'Profile setup failed.');
          return;
        }
      }
      setData(null);
      setUpcoming([]);
      setErr(msg || 'Failed to load plan');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [userId]);

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.wrap}>
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>Plan</Text>
        <Text style={styles.heroTitle}>Today&apos;s Plan</Text>
        <Text style={styles.heroText}>Stay consistent. One session at a time.</Text>
      </View>

      {err ? <Text style={styles.err}>{err}</Text> : null}

      {data ? (
        <>
          <View style={styles.card}>
            <Text style={styles.h1}>Today: {data.session_type}</Text>
            {!isC25KSession(data) ? <Text style={styles.p}>Planned distance: {data.planned_km} km</Text> : null}
            {data.interval ? (
              <>
                <Text style={styles.p}>
                  Guided: {String(data.interval.run || '')} min run / {String(data.interval.walk || '')} min walk, repeats{' '}
                  {String(data.interval.repeats || '')}
                </Text>
                <Text style={styles.notes}>{workoutSummary(data)}</Text>
              </>
            ) : null}
            {data.notes && !String(data.notes).startsWith('C25K|') ? <Text style={styles.notes}>{data.notes}</Text> : null}
          </View>

          {String(data.session_type || '').toLowerCase() === 'rest' && upcoming.length ? (
            <View style={styles.card}>
              <Text style={styles.sectionEyebrow}>Rest Day</Text>
              <Text style={styles.h1}>Next Run: {formatDay(upcoming[0].day)}</Text>
              <View style={styles.heroWorkoutPill}>
                <Text style={styles.heroWorkoutPillText}>{upcoming[0].session_type}</Text>
              </View>
              <Text style={styles.notes}>{workoutSummary(upcoming[0])}</Text>
            </View>
          ) : null}

          {upcoming.length ? (
            <View style={styles.card}>
              <Text style={styles.h1}>Upcoming Workouts</Text>
              {upcoming.map((w) => {
                const expanded = expandedDay === w.day;
                return (
                  <Pressable key={w.day} style={styles.upcomingItem} onPress={() => setExpandedDay(expanded ? null : w.day)}>
                    <View style={styles.upcomingHead}>
                      <View style={styles.upcomingDayWrap}>
                        <Text style={styles.upcomingDay}>{formatDay(w.day)}</Text>
                        <Text style={styles.upcomingTapHint}>{expanded ? 'Tap to collapse' : 'Tap to expand'}</Text>
                      </View>
                      <Text style={styles.upcomingType}>{w.session_type}</Text>
                    </View>
                    <Text style={styles.upcomingMeta}>
                      {isC25KSession(w)
                        ? `${w.total_motion_min ? `${w.total_motion_min} min motion` : 'Guided run/walk'}`
                        : `${w.planned_km} km${w.total_motion_min ? ` • ${w.total_motion_min} min motion` : ''}`}
                    </Text>
                    {expanded ? (
                      <View style={styles.detailBox}>
                        <Text style={styles.detailTitle}>Session Breakdown</Text>
                        <Text style={styles.notes}>{workoutSummary(w)}</Text>
                      </View>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          ) : null}
        </>
      ) : (
        <Text style={styles.p}>No plan loaded.</Text>
      )}

      <Pressable onPress={load} style={styles.refresh}>
        <Text style={styles.refreshText}>{loading ? 'Loading...' : 'Refresh Plan'}</Text>
      </Pressable>
    </ScrollView>
  );
}

function formatDay(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function workoutSummary(w: MobileUpcomingWorkout | MobilePlanToday): string {
  const interval = w.interval || null;
  if (!interval) {
    return w.notes || `${w.session_type} • ${w.planned_km} km`;
  }
  const warmup = Number(interval.warmup || 5);
  const run = Number(interval.run || 0);
  const walk = Number(interval.walk || 0);
  const repeats = Number(interval.repeats || 0);
  const cooldown = Number(interval.cooldown || 5);
  const motion = Math.round(warmup + cooldown + (run + walk) * repeats);
  return `${warmup} min warm-up • ${repeats} x (${run} min run / ${walk} min walk) • ${cooldown} min cool-down • ${motion} min motion`;
}

function isC25KSession(w: MobileUpcomingWorkout | MobilePlanToday): boolean {
  const sessionType = String(w.session_type || '').toLowerCase();
  if (sessionType.includes('c25k')) return true;
  const notes = String(w.notes || '');
  if (notes.startsWith('C25K|')) return true;
  if (w.interval && w.interval.run && w.interval.walk) return true;
  return false;
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  wrap: { gap: theme.space.md },
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
  heroTitle: { fontWeight: '800', fontSize: 22, color: theme.colors.text },
  heroText: { color: theme.colors.textMuted },
  refresh: { backgroundColor: theme.colors.accent, borderRadius: theme.radius.md, padding: 12, alignItems: 'center' },
  refreshText: { color: theme.colors.accentText, fontWeight: '700' },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: 14,
    borderWidth: 1,
    borderColor: theme.colors.border,
    gap: 8,
    ...shadow,
  },
  h1: { fontWeight: '700', fontSize: 18, color: theme.colors.text },
  p: { color: theme.colors.text },
  notes: { color: theme.colors.textMuted, fontSize: 12, lineHeight: 18 },
  sectionEyebrow: { color: theme.colors.textMuted, fontWeight: '700', fontSize: 11, letterSpacing: 0.3 },
  heroWorkoutPill: {
    alignSelf: 'flex-start',
    backgroundColor: theme.colors.accentSoft,
    borderColor: theme.colors.accent,
    borderWidth: 1,
    borderRadius: theme.radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  heroWorkoutPillText: { color: theme.colors.accent, fontWeight: '800', fontSize: 12 },
  upcomingItem: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    padding: 10,
    gap: 4,
    backgroundColor: theme.colors.surfaceAlt,
  },
  upcomingHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  upcomingDayWrap: { gap: 2 },
  upcomingDay: { color: theme.colors.text, fontWeight: '700' },
  upcomingTapHint: { color: theme.colors.textMuted, fontSize: 11 },
  upcomingType: { color: theme.colors.accent, fontWeight: '700' },
  upcomingMeta: { color: theme.colors.textMuted, fontSize: 12 },
  detailBox: {
    marginTop: 6,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: 8,
    gap: 2,
  },
  detailTitle: { color: theme.colors.text, fontWeight: '700', fontSize: 12 },
  err: { color: theme.colors.danger },
});
