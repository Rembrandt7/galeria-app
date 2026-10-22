import React, { useEffect, useRef, useState } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  PanResponder,
  ScrollView,
  StatusBar,
  SafeAreaView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useVideoPlayer, VideoView } from 'expo-video';
import * as MediaLibrary from 'expo-media-library';
import { File, Paths } from 'expo-file-system';
import { trim } from 'react-native-video-trim';
import { theme } from '../constants/theme';

const FRAME = 1 / 30; // paso de un cuadro (aprox. 30 fps)
const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4];

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function formatTime(sec) {
  const s = Math.max(0, sec || 0);
  const m = Math.floor(s / 60);
  const rest = (s - m * 60).toFixed(2).padStart(5, '0');
  return `${m}:${rest}`;
}

export default function VideoPlayerScreen({ asset, onClose, onSaved }) {
  if (!asset?.uri) return null;

  const player = useVideoPlayer({ uri: asset.uri }, (p) => {
    p.timeUpdateEventInterval = 0.1;
    p.loop = false;
    p.play();
  });

  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [rate, setRate] = useState(1);
  const [trimStart, setTrimStart] = useState(null);
  const [trimEnd, setTrimEnd] = useState(null);
  const [busy, setBusy] = useState(false);

  const barWidth = useRef(1);
  const durationRef = useRef(0);
  durationRef.current = duration;

  useEffect(() => {
    const subs = [
      player.addListener('timeUpdate', ({ currentTime }) => {
        setTime(currentTime);
        if (player.duration) setDuration(player.duration);
      }),
      player.addListener('playingChange', ({ isPlaying }) => setPlaying(isPlaying)),
      player.addListener('sourceLoad', ({ duration: d }) => {
        if (d) setDuration(d);
      }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, [player]);

  const seekTo = (t) => {
    const max = durationRef.current || t;
    const target = clamp(t, 0, max);
    player.currentTime = target;
    setTime(target);
  };

  // Barra de progreso táctil
  const seekResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        const ratio = clamp(e.nativeEvent.locationX / barWidth.current, 0, 1);
        seekTo(ratio * durationRef.current);
      },
      onPanResponderMove: (e) => {
        const ratio = clamp(e.nativeEvent.locationX / barWidth.current, 0, 1);
        seekTo(ratio * durationRef.current);
      },
    })
  ).current;

  const togglePlay = () => {
    if (playing) {
      player.pause();
    } else {
      if (duration && time >= duration - 0.05) seekTo(0);
      player.play();
    }
  };

  const stop = () => {
    player.pause();
    seekTo(0);
  };

  const seekBy = (delta) => seekTo(player.currentTime + delta);

  const stepFrame = (dir) => {
    player.pause();
    seekTo(player.currentTime + dir * FRAME);
  };

  const changeSpeed = (r) => {
    player.playbackRate = r;
    setRate(r);
  };

  const markStart = () => {
    const t = player.currentTime;
    setTrimStart(t);
    if (trimEnd !== null && trimEnd <= t) setTrimEnd(null);
  };

  const markEnd = () => {
    const t = player.currentTime;
    setTrimEnd(t);
    if (trimStart !== null && trimStart >= t) setTrimStart(null);
  };

  const clearMarks = () => {
    setTrimStart(null);
    setTrimEnd(null);
  };

  const handleTrim = async () => {
    const start = trimStart ?? 0;
    const end = trimEnd ?? duration;
    if (!(end > start)) {
      Alert.alert('Recorte', 'Marca un inicio y un final válidos.');
      return;
    }
    player.pause();
    setBusy(true);
    try {
      let source = asset.uri;
      if (source.startsWith('content://')) {
        const dest = new File(Paths.cache, `trim_src_${Date.now()}.mp4`);
        new File(source).copy(dest);
        source = dest.uri;
      }
      const result = await trim(source, {
        startTime: Math.round(start * 1000),
        endTime: Math.round(end * 1000),
      });
      const out = result.outputPath.startsWith('file://')
        ? result.outputPath
        : `file://${result.outputPath}`;
      await MediaLibrary.saveToLibraryAsync(out);
      Alert.alert('Listo', 'El video recortado se guardó en tu galería como una copia nueva.');
      clearMarks();
      if (onSaved) onSaved();
    } catch (e) {
      Alert.alert('No se pudo recortar', String(e?.message || e));
    }
    setBusy(false);
  };

  const pct = (t) => (duration ? `${clamp((t / duration) * 100, 0, 100)}%` : '0%');
  const progress = pct(time);
  const hasRange = trimStart !== null || trimEnd !== null;

  return (
    <Modal visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />
      <SafeAreaView style={styles.container}>
        <View style={styles.topBar}>
          <TouchableOpacity onPress={onClose} style={styles.iconBtn}>
            <Ionicons name="close" size={26} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.title} numberOfLines={1}>
            {asset.filename || 'Video'}
          </Text>
          <View style={styles.iconBtn} />
        </View>

        <TouchableOpacity style={styles.videoArea} activeOpacity={1} onPress={togglePlay}>
          <VideoView
            player={player}
            style={styles.video}
            contentFit="contain"
            nativeControls={false}
          />
        </TouchableOpacity>

        <ScrollView style={styles.panel} contentContainerStyle={styles.panelContent}>
          {/* Tiempo */}
          <View style={styles.timeRow}>
            <Text style={styles.timeText}>{formatTime(time)}</Text>
            <Text style={styles.timeText}>{formatTime(duration)}</Text>
          </View>

          {/* Barra de progreso */}
          <View
            style={styles.barTouch}
            onLayout={(e) => {
              barWidth.current = e.nativeEvent.layout.width || 1;
            }}
            {...seekResponder.panHandlers}
          >
            <View style={styles.barTrack} pointerEvents="none" />
            {hasRange && (
              <View
                pointerEvents="none"
                style={[
                  styles.barRange,
                  {
                    left: pct(trimStart ?? 0),
                    width: `${
                      duration
                        ? clamp((((trimEnd ?? duration) - (trimStart ?? 0)) / duration) * 100, 0, 100)
                        : 0
                    }%`,
                  },
                ]}
              />
            )}
            <View pointerEvents="none" style={[styles.barFill, { width: progress }]} />
            <View pointerEvents="none" style={[styles.thumb, { left: progress }]} />
          </View>

          {/* Controles principales */}
          <View style={styles.row}>
            <Ctrl icon="play-skip-back" label="-10s" onPress={() => seekBy(-10)} />
            <Ctrl icon="play-back" label="-5s" onPress={() => seekBy(-5)} />
            <Ctrl icon="chevron-back" label="Cuadro" onPress={() => stepFrame(-1)} />
            <TouchableOpacity style={styles.playBtn} onPress={togglePlay}>
              <Ionicons name={playing ? 'pause' : 'play'} size={32} color="#fff" />
            </TouchableOpacity>
            <Ctrl icon="chevron-forward" label="Cuadro" onPress={() => stepFrame(1)} />
            <Ctrl icon="play-forward" label="+5s" onPress={() => seekBy(5)} />
            <Ctrl icon="play-skip-forward" label="+10s" onPress={() => seekBy(10)} />
          </View>

          <View style={styles.rowCenter}>
            <TouchableOpacity style={styles.stopBtn} onPress={stop}>
              <Ionicons name="stop" size={18} color="#fff" />
              <Text style={styles.stopText}>Stop</Text>
            </TouchableOpacity>
          </View>

          {/* Velocidad */}
          <Text style={styles.sectionLabel}>Velocidad (lenta / rápida)</Text>
          <View style={styles.speedRow}>
            {SPEEDS.map((r) => (
              <TouchableOpacity
                key={r}
                style={[styles.speedChip, rate === r && styles.speedChipActive]}
                onPress={() => changeSpeed(r)}
              >
                <Text style={[styles.speedText, rate === r && styles.speedTextActive]}>{r}x</Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Recorte */}
          <Text style={styles.sectionLabel}>Recortar video</Text>
          <View style={styles.trimRow}>
            <TouchableOpacity style={styles.trimBtn} onPress={markStart}>
              <Text style={styles.trimBtnText}>Marcar inicio</Text>
              <Text style={styles.trimTime}>{trimStart === null ? '0:00.00' : formatTime(trimStart)}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.trimBtn} onPress={markEnd}>
              <Text style={styles.trimBtnText}>Marcar final</Text>
              <Text style={styles.trimTime}>{trimEnd === null ? formatTime(duration) : formatTime(trimEnd)}</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.trimRow}>
            <TouchableOpacity style={[styles.saveBtn, busy && { opacity: 0.6 }]} onPress={handleTrim} disabled={busy}>
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Ionicons name="cut" size={18} color="#fff" />
                  <Text style={styles.saveText}>Recortar y guardar copia</Text>
                </>
              )}
            </TouchableOpacity>
            {hasRange && !busy && (
              <TouchableOpacity style={styles.clearBtn} onPress={clearMarks}>
                <Ionicons name="close-circle-outline" size={22} color={theme.colors.textSecondary} />
              </TouchableOpacity>
            )}
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function Ctrl({ icon, label, onPress }) {
  return (
    <TouchableOpacity style={styles.ctrl} onPress={onPress}>
      <Ionicons name={icon} size={22} color="#fff" />
      <Text style={styles.ctrlLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { color: '#fff', fontSize: 15, fontWeight: '600', flex: 1, textAlign: 'center' },
  videoArea: { flex: 1, backgroundColor: '#000', minHeight: 180 },
  video: { flex: 1 },
  panel: { maxHeight: '58%', backgroundColor: theme.colors.background },
  panelContent: { padding: 16, paddingBottom: 28 },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  timeText: { color: theme.colors.textSecondary, fontSize: 12, fontVariant: ['tabular-nums'] },
  barTouch: { height: 36, justifyContent: 'center', marginBottom: 12 },
  barTrack: { height: 6, borderRadius: 3, backgroundColor: theme.colors.surfaceBorder },
  barRange: {
    position: 'absolute',
    height: 12,
    top: 12,
    backgroundColor: 'rgba(245, 158, 11, 0.45)',
    borderRadius: 3,
  },
  barFill: {
    position: 'absolute',
    height: 6,
    top: 15,
    borderRadius: 3,
    backgroundColor: theme.colors.primary,
  },
  thumb: {
    position: 'absolute',
    top: 8,
    width: 20,
    height: 20,
    marginLeft: -10,
    borderRadius: 10,
    backgroundColor: '#fff',
  },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowCenter: { alignItems: 'center', marginTop: 12 },
  ctrl: { alignItems: 'center', width: 44 },
  ctrlLabel: { color: theme.colors.textSecondary, fontSize: 9, marginTop: 2 },
  playBtn: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: theme.colors.surfaceHover,
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 20,
  },
  stopText: { color: '#fff', fontWeight: '600' },
  sectionLabel: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
    marginTop: 18,
    marginBottom: 8,
  },
  speedRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  speedChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  speedChipActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  speedText: { color: theme.colors.textSecondary, fontWeight: '600' },
  speedTextActive: { color: '#fff' },
  trimRow: { flexDirection: 'row', gap: 10, marginBottom: 10, alignItems: 'center' },
  trimBtn: {
    flex: 1,
    backgroundColor: theme.colors.surface,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.colors.warning,
  },
  trimBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  trimTime: { color: theme.colors.warning, fontSize: 12, marginTop: 2 },
  saveBtn: {
    flex: 1,
    flexDirection: 'row',
    gap: 8,
    backgroundColor: theme.colors.accent,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveText: { color: '#fff', fontWeight: '700' },
  clearBtn: { padding: 6 },
});
