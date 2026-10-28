import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export default function SegmentBar({
  activeSegment = 'photos', // 'photos' | 'files' | 'all'
  onSelectSegment,
  photosCount = 0,
  filesCount = 0,
  allCount = 0,
  labelMode = 'albums', // 'albums' | 'assets'
}) {
  const segments = [
    {
      key: 'photos',
      label: 'Fotos y Dron',
      icon: 'camera',
      iconOutline: 'camera-outline',
      count: photosCount,
      activeBg: '#2563eb',
      activeText: '#ffffff',
      activeBorder: '#60a5fa',
      badgeBg: 'rgba(255, 255, 255, 0.22)',
    },
    {
      key: 'files',
      label: 'Archivos y Redes',
      icon: 'folder-open',
      iconOutline: 'folder-outline',
      count: filesCount,
      activeBg: '#d97706',
      activeText: '#ffffff',
      activeBorder: '#fbbf24',
      badgeBg: 'rgba(255, 255, 255, 0.22)',
    },
    {
      key: 'all',
      label: 'Todo',
      icon: 'grid',
      iconOutline: 'grid-outline',
      count: allCount,
      activeBg: '#374151',
      activeText: '#ffffff',
      activeBorder: '#9ca3af',
      badgeBg: 'rgba(255, 255, 255, 0.18)',
    },
  ];

  return (
    <View style={styles.outerContainer}>
      <View style={styles.segmentTrack}>
        {segments.map((seg) => {
          const isActive = activeSegment === seg.key;
          return (
            <TouchableOpacity
              key={`segment_${seg.key}`}
              style={[
                styles.segmentTab,
                isActive && {
                  backgroundColor: seg.activeBg,
                  borderColor: seg.activeBorder,
                  borderWidth: 1,
                  shadowColor: seg.activeBg,
                  shadowOpacity: 0.35,
                  shadowRadius: 6,
                  elevation: 4,
                },
              ]}
              onPress={() => onSelectSegment && onSelectSegment(seg.key)}
              activeOpacity={0.78}
            >
              <Ionicons
                name={isActive ? seg.icon : seg.iconOutline}
                size={14}
                color={isActive ? seg.activeText : '#94a3b8'}
                style={{ marginRight: 5 }}
              />
              <Text
                style={[
                  styles.segmentLabel,
                  isActive ? { color: seg.activeText, fontWeight: '800' } : styles.segmentLabelInactive,
                ]}
                numberOfLines={1}
              >
                {seg.label}
              </Text>

              {seg.count > 0 && (
                <View
                  style={[
                    styles.countBadge,
                    isActive
                      ? { backgroundColor: seg.badgeBg }
                      : styles.countBadgeInactive,
                  ]}
                >
                  <Text
                    style={[
                      styles.countText,
                      isActive ? { color: '#ffffff' } : styles.countTextInactive,
                    ]}
                  >
                    {seg.count > 999 ? `${(seg.count / 1000).toFixed(1)}k` : seg.count}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outerContainer: {
    paddingHorizontal: 10,
    paddingTop: 4,
    paddingBottom: 6,
    backgroundColor: '#09090b',
  },
  segmentTrack: {
    flexDirection: 'row',
    backgroundColor: '#18181b',
    borderRadius: 14,
    padding: 3,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    alignItems: 'center',
    gap: 3,
  },
  segmentTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 7,
    paddingHorizontal: 6,
    borderRadius: 11,
    minHeight: 34,
  },
  segmentLabel: {
    fontSize: 11.5,
    letterSpacing: -0.2,
  },
  segmentLabelInactive: {
    color: '#94a3b8',
    fontWeight: '600',
  },
  countBadge: {
    marginLeft: 5,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 8,
    minWidth: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countBadgeInactive: {
    backgroundColor: '#27272a',
  },
  countText: {
    fontSize: 10,
    fontWeight: '800',
  },
  countTextInactive: {
    color: '#a1a1aa',
  },
});
