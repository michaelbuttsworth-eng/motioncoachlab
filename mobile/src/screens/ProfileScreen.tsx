import React from 'react';
import { Alert, Linking, NativeModules, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { shadow, theme } from '../ui/theme';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { flushSyncQueue, getPendingSyncCount } from '../lib/api';
import * as Notifications from 'expo-notifications';
import * as Location from 'expo-location';

type Props = {
  userId: number;
  userName: string;
  backgroundMode: boolean;
  onBackgroundModeChange: (next: boolean) => void;
  guidedCuesEnabled: boolean;
  onGuidedCuesEnabledChange: (next: boolean) => void;
  cueDetailMode: boolean;
  onCueDetailModeChange: (next: boolean) => void;
  keepScreenAwake: boolean;
  onKeepScreenAwakeChange: (next: boolean) => void;
  testWarmupMin: 1 | 5;
  onTestWarmupMinChange: (next: 1 | 5) => void;
  onResetSetup: () => Promise<void> | void;
};

const SUPPORT_EMAIL = 'support@buttsworthlabs.com';
export default function ProfileScreen({
  userId,
  userName,
  backgroundMode,
  onBackgroundModeChange,
  guidedCuesEnabled,
  onGuidedCuesEnabledChange,
  cueDetailMode,
  onCueDetailModeChange,
  keepScreenAwake,
  onKeepScreenAwakeChange,
  testWarmupMin,
  onTestWarmupMinChange,
  onResetSetup,
}: Props) {
  const healthModuleRef = React.useRef<any>(Platform.OS === 'ios' ? (NativeModules as any).MCLHealthKitManager : null);
  const [diag, setDiag] = React.useState<string[]>([]);
  const [pendingCount, setPendingCount] = React.useState(0);
  const DIAG_STORAGE_KEY = 'mcl_session_diag_v1';

  const refreshSettingsMeta = React.useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(DIAG_STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      setDiag(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string').slice(0, 20) : []);
    } catch {
      setDiag([]);
    }
    try {
      setPendingCount(await getPendingSyncCount());
    } catch {
      setPendingCount(0);
    }
  }, []);

  React.useEffect(() => {
    refreshSettingsMeta();
  }, [refreshSettingsMeta]);

  const sendSupportEmail = async () => {
    const subject = encodeURIComponent('Motion Coach feedback');
    const body = encodeURIComponent(`User ID: ${userId}\n\nFeedback:\n`);
    const url = `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
    const ok = await Linking.canOpenURL(url);
    if (!ok) {
      Alert.alert('Email unavailable', `Please email ${SUPPORT_EMAIL} from your mail app.`);
      return;
    }
    await Linking.openURL(url);
  };

  const requestCorePermissions = async () => {
    try {
      await Notifications.requestPermissionsAsync();
      await Location.requestForegroundPermissionsAsync();
      await Location.requestBackgroundPermissionsAsync();
      if (Platform.OS === 'ios') {
        await healthModuleRef.current?.requestAccess?.();
      }
      Alert.alert('Permissions checked', 'Notifications, location, and Health access were requested.');
    } catch {
      Alert.alert('Permissions', 'Could not request permissions. Please check Settings > Motion Coach.');
    }
  };

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.wrap}>
      <View style={styles.card}>
        <Text style={styles.h1}>Settings</Text>
        <Text style={styles.meta}>
          {userName} • ID {userId}
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.h1}>Run Settings</Text>
        <View style={styles.settingList}>
          <SettingRow
            title="Background tracking"
            subtitle="Keep guided runs active when app is not in foreground."
            value={backgroundMode}
            onPress={() => onBackgroundModeChange(!backgroundMode)}
          />
          <SettingRow
            title="Guided cues"
            subtitle="Play voice prompts during each phase of your run."
            value={guidedCuesEnabled}
            onPress={() => onGuidedCuesEnabledChange(!guidedCuesEnabled)}
          />
          <SettingRow
            title="Cue detail"
            subtitle="Extra detail in cues like interval counts and summaries."
            value={cueDetailMode}
            onPress={() => onCueDetailModeChange(!cueDetailMode)}
          />
          <SettingRow
            title="Keep screen awake"
            subtitle="Prevent auto-lock while Run screen is open."
            value={keepScreenAwake}
            onPress={() => onKeepScreenAwakeChange(!keepScreenAwake)}
          />
          <View style={styles.settingRow}>
            <View style={styles.settingTextWrap}>
              <Text style={styles.settingTitle}>Warm-up length</Text>
              <Text style={styles.settingSubtitle}>Testing shortcut. Choose 1m or full 5m.</Text>
            </View>
            <View style={styles.inlineGroup}>
              <Pressable style={[styles.inlineChoice, testWarmupMin === 1 && styles.inlineChoiceOn]} onPress={() => onTestWarmupMinChange(1)}>
                <Text style={[styles.inlineChoiceText, testWarmupMin === 1 && styles.inlineChoiceTextOn]}>1m</Text>
              </Pressable>
              <Pressable style={[styles.inlineChoice, testWarmupMin === 5 && styles.inlineChoiceOn]} onPress={() => onTestWarmupMinChange(5)}>
                <Text style={[styles.inlineChoiceText, testWarmupMin === 5 && styles.inlineChoiceTextOn]}>5m</Text>
              </Pressable>
            </View>
          </View>
        </View>
        <Pressable
          style={styles.btn}
          onPress={async () => {
            const res = await flushSyncQueue();
            await refreshSettingsMeta();
            Alert.alert('Sync complete', `Flushed ${res.flushed}, remaining ${res.remaining}`);
          }}
        >
          <Text style={styles.btnText}>Sync Pending Now {pendingCount ? `(${pendingCount})` : ''}</Text>
        </Pressable>
        <Pressable style={styles.secondaryBtn} onPress={requestCorePermissions}>
          <Text style={styles.secondaryBtnText}>Check Permissions</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.h1}>Session Diagnostics</Text>
        {diag.length ? diag.map((d, i) => <Text key={i} style={styles.diagLine}>{d}</Text>) : <Text style={styles.meta}>No events yet.</Text>}
        <Pressable style={styles.secondaryBtn} onPress={refreshSettingsMeta}>
          <Text style={styles.secondaryBtnText}>Refresh Diagnostics</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.h1}>Support</Text>
        <Pressable style={styles.btn} onPress={sendSupportEmail}>
          <Text style={styles.btnText}>Send Feedback</Text>
        </Pressable>
        {__DEV__ ? <Text style={styles.devNote}>Test tools are available in development builds only.</Text> : null}
      </View>

      <View style={styles.card}>
        <Text style={styles.h1}>Account</Text>
        <Pressable style={styles.dangerBtn} onPress={() => onResetSetup()}>
          <Text style={styles.dangerBtnText}>Create New Plan</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

function SettingRow({
  title,
  subtitle,
  value,
  onPress,
}: {
  title: string;
  subtitle: string;
  value: boolean;
  onPress: () => void;
}) {
  return (
    <View style={styles.settingRow}>
      <View style={styles.settingTextWrap}>
        <Text style={styles.settingTitle}>{title}</Text>
        <Text style={styles.settingSubtitle}>{subtitle}</Text>
      </View>
      <Pressable style={[styles.pillToggle, value && styles.pillToggleOn]} onPress={onPress}>
        <Text style={[styles.pillToggleText, value && styles.pillToggleTextOn]}>{value ? 'On' : 'Off'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  wrap: { gap: theme.space.md, paddingBottom: 28 },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 14,
    gap: 10,
    ...shadow,
  },
  h1: { color: theme.colors.text, fontSize: 16, fontWeight: '700' },
  meta: { color: theme.colors.textMuted },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { color: theme.colors.text, fontWeight: '600' },
  toggle: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  toggleOn: { backgroundColor: theme.colors.accentSoft, borderColor: theme.colors.accent },
  toggleText: { color: theme.colors.text, fontWeight: '700' },
  toggleTextOn: { color: theme.colors.accent },
  btn: { backgroundColor: theme.colors.accent, borderRadius: theme.radius.md, paddingVertical: 11, alignItems: 'center' },
  btnText: { color: theme.colors.accentText, fontWeight: '700' },
  secondaryBtn: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.md,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  secondaryBtnText: { color: theme.colors.text, fontWeight: '700' },
  settingList: { gap: 12 },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  settingTextWrap: { flex: 1, gap: 2 },
  settingTitle: { color: theme.colors.text, fontWeight: '700', fontSize: 14 },
  settingSubtitle: { color: theme.colors.textMuted, fontSize: 12, lineHeight: 16 },
  pillToggle: {
    minWidth: 64,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 14,
    paddingVertical: 8,
    alignItems: 'center',
  },
  pillToggleOn: { backgroundColor: theme.colors.accentSoft, borderColor: theme.colors.accent },
  pillToggleText: { color: theme.colors.text, fontWeight: '700', fontSize: 12 },
  pillToggleTextOn: { color: theme.colors.accent, fontWeight: '800' },
  inlineGroup: {
    flexDirection: 'row',
    borderRadius: theme.radius.pill,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  inlineChoice: {
    minWidth: 48,
    paddingVertical: 8,
    paddingHorizontal: 10,
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceAlt,
  },
  inlineChoiceOn: { backgroundColor: theme.colors.accentSoft },
  inlineChoiceText: { color: theme.colors.text, fontWeight: '700', fontSize: 12 },
  inlineChoiceTextOn: { color: theme.colors.accent, fontWeight: '800' },
  diagLine: { color: theme.colors.textMuted, fontSize: 12 },
  dangerBtn: {
    backgroundColor: theme.colors.dangerSoft,
    borderColor: '#f4cccc',
    borderWidth: 1,
    borderRadius: theme.radius.md,
    paddingVertical: 11,
    alignItems: 'center',
  },
  dangerBtnText: { color: theme.colors.danger, fontWeight: '700' },
  devNote: { color: theme.colors.textMuted, fontSize: 12 },
});
