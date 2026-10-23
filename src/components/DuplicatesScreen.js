import React, { useCallback, useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  FlatList,
  StatusBar,
  SafeAreaView,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';
import { duplicateService } from '../services/duplicateService';
import { mediaService } from '../services/mediaService';
import { folderService } from '../services/folderService';

const THUMB = 104;

const formatSize = (bytes) => {
  if (!bytes) return '';
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
};

async function deleteItems(items) {
  const library = items.filter((a) => !a.fromFolder).map((a) => a.id);
  const folder = items.filter((a) => a.fromFolder);
  if (library.length) {
    const ok = await mediaService.deleteAssets(library);
    if (!ok) return false;
  }
  for (const f of folder) {
    await folderService.deleteFile(f.uri);
  }
  return true;
}

export default function DuplicatesScreen({ visible, sourceAssets, onClose, onChanged }) {
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState('');
  const [groups, setGroups] = useState([]);
  const [keep, setKeep] = useState({}); // groupKey -> id a conservar
  const [preview, setPreview] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [scanned, setScanned] = useState(false);

  const scan = useCallback(async () => {
    setScanning(true);
    setScanned(false);
    setGroups([]);
    try {
      const photos =
        sourceAssets && sourceAssets.length
          ? sourceAssets
          : await duplicateService.loadAllPhotos(({ done }) =>
              setProgress(`Leyendo galería… ${done} fotos`)
            );
      const found = await duplicateService.findDuplicates(photos, ({ phase, done, total }) => {
        if (phase === 'sizes') setProgress(`Analizando tamaños… ${done}/${total}`);
        else setProgress(`Comparando contenido… ${done}/${total}`);
      });
      const defaults = {};
      found.forEach((g) => {
        defaults[g.key] = g.items[0].id;
      });
      setKeep(defaults);
      setGroups(found);
    } catch (e) {
      Alert.alert('Error', 'No se pudo buscar fotos duplicadas.');
    }
    setScanning(false);
    setScanned(true);
  }, [sourceAssets]);

  useEffect(() => {
    if (visible) scan();
    else {
      setGroups([]);
      setPreview(null);
    }
  }, [visible]);

  const removeFromGroups = (deletedIds) => {
    setGroups((prev) =>
      prev
        .map((g) => ({ ...g, items: g.items.filter((a) => !deletedIds.includes(a.id)) }))
        .filter((g) => g.items.length > 1)
    );
  };

  const keepOnlyOne = (group) => {
    const keepId = keep[group.key];
    const toDelete = group.items.filter((a) => a.id !== keepId);
    Alert.alert(
      'Dejar solo una',
      `Se conservará la foto seleccionada y se eliminarán ${toDelete.length} copia(s).`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Eliminar copias',
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            try {
              if (await deleteItems(toDelete)) {
                removeFromGroups(toDelete.map((a) => a.id));
                if (onChanged) onChanged();
              }
            } catch (e) {
              Alert.alert('No se pudo eliminar', 'Revisa los permisos e inténtalo de nuevo.');
            }
            setDeleting(false);
          },
        },
      ]
    );
  };

  const allCopies = groups.flatMap((g) => g.items.filter((a) => a.id !== keep[g.key]));
  const totalSavingsBytes = allCopies.reduce((acc, a) => acc + (a.size || 0), 0);

  const deleteAllCopies = () => {
    Alert.alert(
      'Eliminar todas las copias',
      `Se conservará una foto por grupo y se eliminarán ${allCopies.length} copias en total (liberando ${formatSize(totalSavingsBytes) || 'espacio'}).`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Eliminar todas',
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            try {
              if (await deleteItems(allCopies)) {
                removeFromGroups(allCopies.map((a) => a.id));
                if (onChanged) onChanged();
              }
            } catch (e) {
              Alert.alert('No se pudo eliminar', 'Revisa los permisos e inténtalo de nuevo.');
            }
            setDeleting(false);
          },
        },
      ]
    );
  };

  const renderGroup = ({ item: group }) => (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>
        {group.items.length} copias · {formatSize(group.items[0].size)}
      </Text>
      <View style={styles.thumbRow}>
        {group.items.map((a, idx) => {
          const kept = keep[group.key] === a.id;
          return (
            <View key={a.id} style={styles.thumbWrap}>
              <TouchableOpacity activeOpacity={0.85} onPress={() => setPreview(a)}>
                <Image
                  source={{ uri: a.uri }}
                  style={[styles.thumb, kept && styles.thumbKept]}
                  contentFit="cover"
                />
              </TouchableOpacity>
              <Text style={styles.thumbName} numberOfLines={1}>
                {a.filename || `Copia ${idx + 1}`}
              </Text>
              <TouchableOpacity
                style={[styles.keepBtn, kept && styles.keepBtnActive]}
                onPress={() => setKeep((prev) => ({ ...prev, [group.key]: a.id }))}
              >
                <Ionicons
                  name={kept ? 'checkmark-circle' : 'ellipse-outline'}
                  size={16}
                  color={kept ? '#fff' : theme.colors.textSecondary}
                />
                <Text style={[styles.keepText, kept && { color: '#fff' }]}>
                  {kept ? 'Conservar' : 'Elegir'}
                </Text>
              </TouchableOpacity>
            </View>
          );
        })}
      </View>
      <TouchableOpacity style={styles.oneBtn} onPress={() => keepOnlyOne(group)} disabled={deleting}>
        <Ionicons name="trash-outline" size={16} color="#fff" />
        <Text style={styles.oneBtnText}>Dejar solo la seleccionada</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <StatusBar barStyle="light-content" backgroundColor={theme.colors.background} />
      <SafeAreaView style={styles.container}>
        <View style={styles.topBar}>
          <TouchableOpacity onPress={onClose} style={styles.iconBtn}>
            <Ionicons name="close" size={26} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.title}>Fotos duplicadas</Text>
          <TouchableOpacity onPress={scan} style={styles.iconBtn} disabled={scanning}>
            <Ionicons name="refresh" size={22} color="#fff" />
          </TouchableOpacity>
        </View>

        {scanning ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={styles.info}>{progress || 'Buscando…'}</Text>
          </View>
        ) : scanned && groups.length === 0 ? (
          <View style={styles.center}>
            <Ionicons name="checkmark-done-circle-outline" size={64} color={theme.colors.primary} />
            <Text style={styles.info}>No se encontraron fotos duplicadas.</Text>
          </View>
        ) : (
          <>
            <View style={styles.summaryBanner}>
              <Ionicons name="analytics-outline" size={16} color={theme.colors.primaryLight} />
              <Text style={styles.summaryText}>
                {groups.length} {groups.length === 1 ? 'grupo' : 'grupos'} · {allCopies.length} copias repetidas · Liberar {formatSize(totalSavingsBytes)}
              </Text>
            </View>
            <FlatList
              data={groups}
              keyExtractor={(g) => g.key}
              renderItem={renderGroup}
              contentContainerStyle={{ padding: 12, paddingBottom: 96 }}
            />
            {groups.length > 0 && (
              <View style={styles.bottomBar}>
                <TouchableOpacity
                  style={[styles.allBtn, deleting && { opacity: 0.6 }]}
                  onPress={deleteAllCopies}
                  disabled={deleting}
                >
                  {deleting ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.allBtnText}>
                      Eliminar todas las copias ({allCopies.length}) · Liberar {formatSize(totalSavingsBytes)}
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            )}
          </>
        )}

        {/* Vista ampliada solo para revisar */}
        {preview && (
          <TouchableOpacity style={styles.previewOverlay} activeOpacity={1} onPress={() => setPreview(null)}>
            <Image source={{ uri: preview.uri }} style={styles.previewImage} contentFit="contain" />
            <Text style={styles.previewHint}>
              {preview.filename || ''} · toca para cerrar
            </Text>
          </TouchableOpacity>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surfaceBorder,
  },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { color: '#fff', fontSize: 18, fontWeight: '700' },
  summaryBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: theme.colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surfaceBorder,
  },
  summaryText: {
    color: theme.colors.primaryLight,
    fontSize: 12,
    fontWeight: '700',
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  info: { color: theme.colors.textSecondary, marginTop: 14, textAlign: 'center' },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: 14,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  cardTitle: { color: '#fff', fontWeight: '700', marginBottom: 10 },
  thumbRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  thumbWrap: { width: THUMB },
  thumb: { width: THUMB, height: THUMB, borderRadius: 10, borderWidth: 2, borderColor: 'transparent' },
  thumbKept: { borderColor: theme.colors.primary },
  thumbName: { color: theme.colors.textSecondary, fontSize: 10, marginTop: 4 },
  keepBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    marginTop: 4,
    paddingVertical: 5,
    borderRadius: 12,
    backgroundColor: theme.colors.surfaceHover,
  },
  keepBtnActive: { backgroundColor: theme.colors.primary },
  keepText: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: '600' },
  oneBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 12,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: theme.colors.danger,
  },
  oneBtnText: { color: '#fff', fontWeight: '700' },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: 12,
    backgroundColor: theme.colors.background,
    borderTopWidth: 1,
    borderTopColor: theme.colors.surfaceBorder,
  },
  allBtn: {
    backgroundColor: theme.colors.dangerHover,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  allBtnText: { color: '#fff', fontWeight: '700' },
  previewOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 50,
  },
  previewImage: { width: '100%', height: '90%' },
  previewHint: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 6 },
});
