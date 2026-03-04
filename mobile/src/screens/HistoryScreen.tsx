import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View, Pressable } from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';
import { getHistory, MobileHistoryItem } from '../lib/api';

export default function HistoryScreen({ userId }: { userId: number }) {
  const [items, setItems] = useState<MobileHistoryItem[]>([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

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

  return (
    <View style={styles.wrap}>
      <Pressable onPress={load} style={styles.refresh}>
        <Text style={styles.refreshText}>{loading ? 'Loading...' : 'Refresh History'}</Text>
      </Pressable>
      {err ? <Text style={styles.err}>{err}</Text> : null}

      <ScrollView contentContainerStyle={styles.list}>
        {items.map((it) => {
          const km = (it.distance_m / 1000).toFixed(2);
          const min = (it.duration_s / 60).toFixed(1);
          const title = new Date(it.started_at).toLocaleString();
          const points = parsePolyline(it.route_polyline || '');
          const region = buildRegion(points);

          return (
            <View key={it.run_id} style={styles.card}>
              <Text style={styles.h1}>{title}</Text>
              <Text style={styles.p}>{km} km • {min} min • {it.pace_min_km || '-'} min/km</Text>
              <Text style={styles.meta}>source: {it.source}</Text>
              {(it.effort || it.fatigue || it.pain || it.session_feel) ? (
                <Text style={styles.meta}>
                  check-in: {it.effort || '-'} / {it.fatigue || '-'} / {it.pain || '-'} / {it.session_feel || '-'}
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
        })}
        {!items.length && !loading ? <Text style={styles.empty}>No runs yet.</Text> : null}
      </ScrollView>
    </View>
  );
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
  refresh: { backgroundColor: '#6b8f41', borderRadius: 10, padding: 12, alignItems: 'center' },
  refreshText: { color: '#fff', fontWeight: '700' },
  list: { gap: 10, paddingBottom: 32 },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#dae6ce', gap: 6 },
  h1: { fontSize: 14, fontWeight: '700', color: '#1f2d1f' },
  p: { color: '#203020' },
  meta: { color: '#526c49', fontSize: 12 },
  map: { height: 140, borderRadius: 8, marginTop: 4 },
  empty: { color: '#526c49' },
  err: { color: '#a32626' },
});
