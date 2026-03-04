import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { generatePlan, upsertOnboarding, upsertProfile } from '../lib/api';

const GOALS = ['5K', '10K', 'Half', 'Marathon'];
const LEVELS = ['New', 'Returning', 'Regular'];
const TIME_OPTIONS = ['Up to 30 min', 'Up to 45 min', 'Up to 60 min'];
const DAYS = [2, 3, 4, 5, 6];

export default function OnboardingScreen({
  userId,
  onDone,
}: {
  userId: number;
  onDone: () => void;
}) {
  const [goal, setGoal] = useState('5K');
  const [level, setLevel] = useState('New');
  const [days, setDays] = useState(3);
  const [timePerRun, setTimePerRun] = useState('Up to 45 min');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    setSaving(true);
    setErr('');
    try {
      await upsertOnboarding(userId, {
        current_step: 99,
        goal_primary: goal,
        ability_level: level,
        weekly_availability: days,
        time_per_run: timePerRun,
      });
      await upsertProfile(userId, {
        goal_mode: 'Build up to run a distance continuously',
        goal_primary: goal,
        ability_level: level,
        weekly_availability: days,
        time_per_run: timePerRun,
        injury_status: 'None',
        preferred_days: 'Mon/Tue/Wed/Thu/Fri/Sat/Sun',
        recent_runs_per_week: 0,
        longest_recent_min: 0,
        continuous_run_min: 5,
        run_walk_ok: 'Yes',
      });
      await generatePlan(userId, 16);
      onDone();
    } catch (e: any) {
      setErr(e?.message || 'Failed to save onboarding');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Set up your plan</Text>
      <Text style={styles.sub}>We need 4 quick choices.</Text>

      <Text style={styles.label}>Goal</Text>
      <View style={styles.row}>
        {GOALS.map((v) => (
          <Pick key={v} text={v} selected={goal === v} onPress={() => setGoal(v)} />
        ))}
      </View>

      <Text style={styles.label}>Current level</Text>
      <View style={styles.row}>
        {LEVELS.map((v) => (
          <Pick key={v} text={v} selected={level === v} onPress={() => setLevel(v)} />
        ))}
      </View>

      <Text style={styles.label}>Run days per week</Text>
      <View style={styles.row}>
        {DAYS.map((v) => (
          <Pick key={String(v)} text={String(v)} selected={days === v} onPress={() => setDays(v)} />
        ))}
      </View>

      <Text style={styles.label}>Time per run</Text>
      <View style={styles.row}>
        {TIME_OPTIONS.map((v) => (
          <Pick key={v} text={v} selected={timePerRun === v} onPress={() => setTimePerRun(v)} />
        ))}
      </View>

      {err ? <Text style={styles.err}>{err}</Text> : null}

      <Pressable style={styles.cta} onPress={submit} disabled={saving}>
        <Text style={styles.ctaText}>{saving ? 'Saving...' : 'Create My Plan'}</Text>
      </Pressable>
    </View>
  );
}

function Pick({
  text,
  selected,
  onPress,
}: {
  text: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={[styles.pill, selected && styles.pillOn]} onPress={onPress}>
      <Text style={[styles.pillText, selected && styles.pillTextOn]}>{text}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10, padding: 16 },
  title: { fontSize: 24, fontWeight: '700', color: '#1e2c1e' },
  sub: { color: '#5a6f54', marginBottom: 6 },
  label: { marginTop: 8, fontWeight: '700', color: '#223422' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: { borderWidth: 1, borderColor: '#bfd4b2', backgroundColor: '#fff', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8 },
  pillOn: { backgroundColor: '#6b8f41', borderColor: '#6b8f41' },
  pillText: { color: '#2c4022', fontWeight: '600' },
  pillTextOn: { color: '#fff' },
  cta: { marginTop: 14, backgroundColor: '#6b8f41', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  ctaText: { color: '#fff', fontWeight: '700' },
  err: { color: '#a32626' },
});

