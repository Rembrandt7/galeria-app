import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export default function SegmentBar({
  activeSegment = 'photos', // 'photos' | 'files'
  activeTab = 'albums',
  onSelectSegment,
  onOpenCamera,
  onOpenExplorer,
  photosCount = 0,
  filesCount = 0,
}) {
  const isExplorerActive = activeTab === 'folder';

  const segments = [
    {
      key: 'photos',
      label: 'Fotos',
      icon: 'images',
      iconOutline: 'images-outline',
      count: photosCount,
      activeBg: '#2563eb',
      activeText: '#ffffff',
      activeBorder: '#60a5fa',
      badgeBg: 'rgba(255, 255, 255, 0.22)',
      isActive: !isExplorerActive && activeSegment === 'photos',
      onPress: () => onSelectSegment && onSelectSegment('photos'),
    },
    {
      key: 'files',
      label: 'Archivos',
      icon: 'lock-open',
      iconOutline: 'lock-closed-outline',
      count: filesCount,
      activeBg: '#d97706',
      activeText: '#ffffff',
      activeBorder: '#fbbf24',
      badgeBg: 'rgba(255, 255, 255, 0.22)',
      isActive: !isExplorerActive && activeSegment === 'files',
      onPress: () => onSelectSegment && onSelectSegment('files'),
    },
    {
      key: 'camera',
      label: '',
      iconOnly: true,
      icon: 'camera',
      iconOutline: 'camera-outline',
      count: 0,
      activeBg: '#0284c7',
      activeText: '#ffffff',
      activeBorder: '#38bdf8',
      badgeBg: 'rgba(255, 255, 255, 0.22)',
      isActive: false,
      onPress: () => onOpenCamera && onOpenCamera(),
    },
    {
      key: 'explorer',
      label: 'Explorador',
      icon: 'folder-open',
      iconOutline: 'folder-outline',
      count: 0,
      activeBg: '#059669',
      activeText: '#ffffff',
      activeBorder: '#34d399',
      badgeBg: 'rgba(255, 255, 255, 0.22)',
      isActive: isExplorerActive,
      onPress: () => onOpenExplorer && onOpenExplorer(),
    },
  ];

  return (
    <View style={styles.outerContainer}>
      <View style={styles.segmentTrack}>
        {segments.map((seg) => {
          const isActive = seg.isActive;
          if (seg.iconOnly) {
            return (
              <TouchableOpacity
                key={`segment_${seg.key}`}
                style={styles.cameraIconBtn}
                onPress={seg.onPress}
                hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                activeOpacity={0.78}
              >
                <Ionicons name="videocam" size={17} color="#ffffff" />
              </TouchableOpacity>
            );
          }
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
              onPress={seg.onPress}
              activeOpacity={0.78}
            >
              <Ionicons
                name={isActive ? seg.icon : seg.iconOutline}
                size={13}
                color={isActive ? seg.activeText : '#94a3b8'}
                style={{ marginRight: 4 }}
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
    paddingHorizontal: 8,
    paddingTop: 3,
    paddingBottom: 5,
    backgroundColor: '#09090b',
  },
  segmentTrack: {
    flexDirection: 'row',
    backgroundColor: '#18181b',
    borderRadius: 13,
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
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderRadius: 10,
    minHeight: 32,
  },
  cameraIconBtn: {
    width: 40,
    height: 32,
    borderRadius: 10,
    backgroundColor: 'rgba(2, 132, 199, 0.28)',
    borderWidth: 1,
    borderColor: '#38bdf8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentLabel: {
    fontSize: 11,
    letterSpacing: -0.2,
  },
  segmentLabelInactive: {
    color: '#94a3b8',
    fontWeight: '600',
  },
  countBadge: {
    marginLeft: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 7,
    minWidth: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countBadgeInactive: {
    backgroundColor: '#27272a',
  },
  countText: {
    fontSize: 9.5,
    fontWeight: '800',
  },
  countTextInactive: {
    color: '#a1a1aa',
  },
});
