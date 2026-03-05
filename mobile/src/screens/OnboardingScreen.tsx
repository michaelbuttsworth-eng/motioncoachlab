import React, { useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { generatePlan, upsertOnboarding, upsertProfile } from '../lib/api';

const GOAL_MODES = ['Prepare for an event', 'Build up to run a distance continuously'];
const GOALS = ['5K', '10K', 'Half', 'Marathon', 'Ultra/Other'];
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
  const [goalMode, setGoalMode] = useState<'Prepare for an event' | 'Build up to run a distance continuously'>('Build up to run a distance continuously');
  const [goal, setGoal] = useState('5K');
  const [goalDate, setGoalDate] = useState('');
  const [startDate, setStartDate] = useState('');
  const [pickerField, setPickerField] = useState<'goal' | 'start' | null>(null);
  const [pickerDate, setPickerDate] = useState<Date>(new Date());
  const [level, setLevel] = useState('New');
  const [days, setDays] = useState(3);
  const [timePerRun, setTimePerRun] = useState('Up to 45 min');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const parseIsoDate = (value: string): Date => {
    if (!value) return new Date();
    const d = new Date(`${value}T00:00:00`);
    return Number.isNaN(d.getTime()) ? new Date() : d;
  };

  const toIsoDate = (d: Date): string => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const toDisplayDate = (value: string): string => {
    if (!value) return 'Select date';
    const d = parseIsoDate(value);
    return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  };

  const openDatePicker = (field: 'goal' | 'start') => {
    const base = field === 'goal' ? goalDate : (startDate || goalDate);
    setPickerDate(parseIsoDate(base));
    setPickerField(field);
  };

  const closeDatePicker = () => setPickerField(null);

  const onDatePickerChange = (event: DateTimePickerEvent, selected?: Date) => {
    if (!selected) {
      if (Platform.OS === 'android') closeDatePicker();
      return;
    }
    if (Platform.OS === 'android') {
      if (event.type === 'set') {
        const iso = toIsoDate(selected);
        if (pickerField === 'goal') setGoalDate(iso);
        if (pickerField === 'start') setStartDate(iso);
      }
      closeDatePicker();
      return;
    }
    setPickerDate(selected);
  };

  const confirmDatePicker = () => {
    const iso = toIsoDate(pickerDate);
    if (pickerField === 'goal') setGoalDate(iso);
    if (pickerField === 'start') setStartDate(iso);
    closeDatePicker();
  };

  const submit = async () => {
    setSaving(true);
    setErr('');
    try {
      const modeDb = goalMode === 'Prepare for an event' ? 'Event prep' : 'Distance build';
      const dateLabel =
        goalMode === 'Prepare for an event'
          ? 'Event date (YYYY-MM-DD)'
          : 'Target date to run full distance (YYYY-MM-DD)';
      if (!goalDate) {
        setErr(`${dateLabel} is required.`);
        setSaving(false);
        return;
      }
      await upsertOnboarding(userId, {
        current_step: 99,
        goal_mode: goalMode,
        goal_primary: goal,
        goal_date: goalDate,
        start_date: startDate || undefined,
        ability_level: level,
        weekly_availability: days,
        time_per_run: timePerRun,
      });
      await upsertProfile(userId, {
        goal_mode: modeDb,
        goal_primary: goal,
        goal_date: goalDate,
        start_date: startDate || undefined,
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
      <Text style={styles.sub}>Quick setup, then we generate your full plan.</Text>

      <Text style={styles.label}>What is your primary goal?</Text>
      <View style={styles.row}>
        {GOAL_MODES.map((v) => (
          <Pick
            key={v}
            text={v}
            selected={goalMode === v}
            onPress={() => setGoalMode(v as 'Prepare for an event' | 'Build up to run a distance continuously')}
          />
        ))}
      </View>

      <Text style={styles.label}>
        {goalMode === 'Prepare for an event' ? 'Event distance' : 'Continuous run distance target'}
      </Text>
      <View style={styles.row}>
        {GOALS.map((v) => (
          <Pick key={v} text={v} selected={goal === v} onPress={() => setGoal(v)} />
        ))}
      </View>

      <Text style={styles.label}>
        {goalMode === 'Prepare for an event'
          ? 'Event date (YYYY-MM-DD)'
          : 'Date you want to run the full distance by'}
      </Text>
      <Pressable style={styles.inputBtn} onPress={() => openDatePicker('goal')}>
        <Text style={styles.inputBtnText}>{toDisplayDate(goalDate)}</Text>
      </Pressable>

      <Text style={styles.label}>Desired start date (optional)</Text>
      <View style={styles.row}>
        <Pressable style={styles.inputBtnGrow} onPress={() => openDatePicker('start')}>
          <Text style={styles.inputBtnText}>{startDate ? toDisplayDate(startDate) : 'Select date (optional)'}</Text>
        </Pressable>
        {startDate ? (
          <Pressable style={styles.clearBtn} onPress={() => setStartDate('')}>
            <Text style={styles.clearBtnText}>Clear</Text>
          </Pressable>
        ) : null}
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

      {pickerField ? (
        <Modal visible transparent animationType="fade" onRequestClose={closeDatePicker}>
          <Pressable style={styles.modalBackdrop} onPress={closeDatePicker}>
            <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
              <Text style={styles.modalTitle}>{pickerField === 'goal' ? 'Pick target date' : 'Pick start date'}</Text>
              <DateTimePicker
                value={pickerDate}
                mode="date"
                display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                onChange={onDatePickerChange}
                minimumDate={pickerField === 'goal' ? new Date() : undefined}
              />
              {Platform.OS === 'ios' ? (
                <View style={styles.modalActions}>
                  <Pressable style={styles.modalBtnSecondary} onPress={closeDatePicker}>
                    <Text style={styles.modalBtnSecondaryText}>Cancel</Text>
                  </Pressable>
                  <Pressable style={styles.modalBtnPrimary} onPress={confirmDatePicker}>
                    <Text style={styles.modalBtnPrimaryText}>Done</Text>
                  </Pressable>
                </View>
              ) : null}
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}
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
  inputBtn: {
    borderWidth: 1,
    borderColor: '#bfd4b2',
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  inputBtnGrow: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#bfd4b2',
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  inputBtnText: { color: '#223422', fontWeight: '600' },
  pickerWrap: {
    borderWidth: 1,
    borderColor: '#dcead0',
    borderRadius: 10,
    backgroundColor: '#fff',
    padding: 6,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.30)',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  modalCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#dae6ce',
  },
  modalTitle: { fontWeight: '700', color: '#223422', marginBottom: 8 },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 8 },
  modalBtnSecondary: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: '#edf4e7' },
  modalBtnSecondaryText: { color: '#31512a', fontWeight: '700' },
  modalBtnPrimary: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: '#6b8f41' },
  modalBtnPrimaryText: { color: '#fff', fontWeight: '700' },
  clearBtn: { paddingHorizontal: 12, borderRadius: 10, backgroundColor: '#edf4e7', justifyContent: 'center' },
  clearBtnText: { color: '#31512a', fontWeight: '700' },
  pill: { borderWidth: 1, borderColor: '#bfd4b2', backgroundColor: '#fff', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8 },
  pillOn: { backgroundColor: '#6b8f41', borderColor: '#6b8f41' },
  pillText: { color: '#2c4022', fontWeight: '600' },
  pillTextOn: { color: '#fff' },
  cta: { marginTop: 14, backgroundColor: '#6b8f41', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  ctaText: { color: '#fff', fontWeight: '700' },
  err: { color: '#a32626' },
});
