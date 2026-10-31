import React, { useCallback, useEffect, useState, useRef } from 'react';
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
  Platform,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';
import { duplicateService } from '../services/duplicateService';
import { mediaService } from '../services/mediaService';
import { folderService } from '../services/folderService';

const THUMB = 108;

const formatSize = (bytes) => {
  if (!bytes || bytes <= 0) return '0 KB';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

async function deleteItems(items) {
  if (!Array.isArray(items) || items.length === 0) return true;
  const remainingLibraryIds = [];

  for (const item of items) {
    if (!item) continue;
    let deletedByFile = false;
    if (item.uri) {
      try {
        deletedByFile = await folderService.deleteFile(item.uri);
      } catch (_e) {
        deletedByFile = false;
      }
    }
    if (!deletedByFile && item.id && !item.fromFolder && /^\d+$/.test(String(item.id))) {
      remainingLibraryIds.push(String(item.id));
    }
  }

  if (remainingLibraryIds.length > 0) {
    try {
      const ok = await mediaService.deleteAssets(remainingLibraryIds);
      if (!ok) return false;
    } catch (_err) {
      return false;
    }
  }

  folderService.invalidateCache();
  if (mediaService._albumsMemCache) {
    mediaService._albumsMemCache = null;
  }
  return true;
}

export default function DuplicatesScreen({
  visible,
  sourceAssets,
  folderUri = null,
  folderName = null,
  onClose,
  onChanged,
}) {
  const hasFolderContext = Boolean(folderUri || (sourceAssets && sourceAssets.length > 0));
  const [scanScope, setScanScope] = useState(hasFolderContext ? 'folder' : 'all'); // 'folder' | 'all'
  const [scanning, setScanning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [progress, setProgress] = useState('');
  const [groups, setGroups] = useState([]);
  const [keep, setKeep] = useState({}); // groupKey -> id a conservar
  const [preview, setPreview] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [totalAnalyzed, setTotalAnalyzed] = useState(0);
  const scanControlRef = useRef(null);

  const runScan = useCallback(
    async (overrideScope) => {
      const effectiveScope = overrideScope || scanScope;
      if (scanControlRef.current?.cancel) {
        scanControlRef.current.cancel();
      }

      let pauseResolve = null;
      let pausePromise = null;
      const ctrl = {
        isPaused: false,
        isCancelled: false,
        pause() {
          if (this.isPaused || this.isCancelled) return;
          this.isPaused = true;
          setIsPaused(true);
          pausePromise = new Promise((r) => {
            pauseResolve = r;
          });
        },
        resume() {
          if (!this.isPaused) return;
          this.isPaused = false;
          setIsPaused(false);
          if (pauseResolve) {
            const r = pauseResolve;
            pauseResolve = null;
            pausePromise = null;
            r();
          }
        },
        cancel() {
          this.isCancelled = true;
          this.isPaused = false;
          setIsPaused(false);
          if (pauseResolve) {
            const r = pauseResolve;
            pauseResolve = null;
            pausePromise = null;
            r();
          }
        },
        async waitIfPaused() {
          while (this.isPaused && pausePromise && !this.isCancelled) {
            await pausePromise;
          }
        },
      };
      scanControlRef.current = ctrl;
      setIsPaused(false);
      setScanning(true);
      setScanned(false);
      setGroups([]);
      setTotalAnalyzed(0);
      setProgress('Preparando análisis de duplicados…');

      try {
        let mediaList = [];
        if (effectiveScope === 'folder' && hasFolderContext) {
          setProgress('Escaneando carpeta y subcarpetas…');
          mediaList = await duplicateService.loadFolderMedia(
            folderUri,
            sourceAssets || [],
            ({ done }) => setProgress(`Leyendo carpeta… ${done} archivos`),
            ctrl
          );
        } else {
          setProgress('Leyendo toda la galería…');
          mediaList = await duplicateService.loadAllPhotos(
            ({ done }) => setProgress(`Leyendo galería… ${done} archivos`),
            ctrl
          );
        }

        if (ctrl.isCancelled) {
          setScanning(false);
          return;
        }

        setTotalAnalyzed(mediaList.length);

        const found = await duplicateService.findDuplicates(
          mediaList,
          ({ phase, done, total }) => {
            if (phase === 'sizes') {
              setProgress(`Analizando pesos… ${done} de ${total}`);
            } else {
              setProgress(`Comparando contenido… ${done} de ${total}`);
            }
          },
          ctrl
        );

        if (ctrl.isCancelled) {
          setScanning(false);
          return;
        }

        const defaults = {};
        found.forEach((g) => {
          const firstItem = g.items[0];
          if (firstItem) {
            defaults[g.key] = firstItem.id || firstItem.uri;
          }
        });
        setKeep(defaults);
        setGroups(found);
      } catch (e) {
        Alert.alert('Error', 'No se pudo completar la búsqueda de duplicados.');
      }
      setScanning(false);
      setIsPaused(false);
      setScanned(true);
    },
    [scanScope, hasFolderContext, folderUri, sourceAssets]
  );

  useEffect(() => {
    if (visible) {
      const initialScope = folderUri || (sourceAssets && sourceAssets.length > 0) ? 'folder' : 'all';
      setScanScope(initialScope);
      runScan(initialScope);
    } else {
      if (scanControlRef.current?.cancel) {
        scanControlRef.current.cancel();
      }
      setGroups([]);
      setPreview(null);
    }
  }, [visible]);

  const handleSelectScope = (nextScope) => {
    if (nextScope === scanScope && !scanned) return;
    setScanScope(nextScope);
    runScan(nextScope);
  };

  const getItemKey = (a) => String(a?.id || a?.uri || '');

  const removeFromGroups = (deletedKeys) => {
    const delSet = new Set(deletedKeys);
    setGroups((prev) =>
      prev
        .map((g) => ({
          ...g,
          items: g.items.filter((a) => !delSet.has(getItemKey(a))),
        }))
        .filter((g) => g.items.length > 1)
    );
  };

  const keepOnlyOne = (group) => {
    const keepId = keep[group.key];
    const toDelete = group.items.filter((a) => getItemKey(a) !== keepId);
    Alert.alert(
      'Dejar solo una',
      `Se conservará el archivo seleccionado y se eliminarán ${toDelete.length} copia(s) repetida(s).`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Eliminar copias',
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            try {
              if (await deleteItems(toDelete)) {
                removeFromGroups(toDelete.map((a) => getItemKey(a)));
                if (onChanged) onChanged();
              } else {
                Alert.alert('Aviso', 'Algunos archivos requieren permiso para eliminarse.');
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

  const allCopies = groups.flatMap((g) =>
    g.items.filter((a) => getItemKey(a) !== keep[g.key])
  );
  const totalSavingsBytes = allCopies.reduce((acc, a) => acc + (a.size || a.fileSize || 0), 0);

  const deleteAllCopies = () => {
    Alert.alert(
      'Eliminar todas las copias',
      `Se conservará 1 original por grupo y se eliminarán ${allCopies.length} copias en total (liberando ${formatSize(totalSavingsBytes)}).`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Eliminar todas',
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            try {
              if (await deleteItems(allCopies)) {
                removeFromGroups(allCopies.map((a) => getItemKey(a)));
                if (onChanged) onChanged();
              } else {
                Alert.alert('Aviso', 'Algunos archivos requieren confirmación adicional.');
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
      <View style={styles.cardHeaderRow}>
        <Text style={styles.cardTitle}>
          {group.items.length} copias · {formatSize(group.items[0]?.size || group.items[0]?.fileSize)} c/u
        </Text>
        <View
          style={[
            styles.matchBadge,
            group.matchType === 'copy_name' && styles.matchBadgeCopyName,
          ]}
        >
          <Text style={styles.matchBadgeText}>
            {group.matchType === 'copy_name' ? 'Copia por nombre/resolución' : 'Idénticos 100%'}
          </Text>
        </View>
      </View>

      <View style={styles.thumbRow}>
        {group.items.map((a, idx) => {
          const itemKey = getItemKey(a);
          const kept = keep[group.key] === itemKey;
          const isVideo = a.mediaType === 'video';
          return (
            <View key={`${itemKey}_${idx}`} style={styles.thumbWrap}>
              <TouchableOpacity activeOpacity={0.85} onPress={() => setPreview(a)}>
                <View style={styles.thumbBox}>
                  <Image
                    source={{ uri: a.uri }}
                    style={[styles.thumb, kept && styles.thumbKept]}
                    contentFit="cover"
                  />
                  {isVideo && (
                    <View style={styles.videoTagPill}>
                      <Ionicons name="videocam" size={10} color="#fff" />
                      <Text style={styles.videoTagText}>VIDEO</Text>
                    </View>
                  )}
                </View>
              </TouchableOpacity>
              <Text style={styles.thumbName} numberOfLines={1}>
                {a.filename || `Copia ${idx + 1}`}
              </Text>
              {a.folderLabel ? (
                <Text style={styles.thumbFolder} numberOfLines={1}>
                  📁 {a.folderLabel}
                </Text>
              ) : null}
              <TouchableOpacity
                style={[styles.keepBtn, kept && styles.keepBtnActive]}
                onPress={() => setKeep((prev) => ({ ...prev, [group.key]: itemKey }))}
              >
                <Ionicons
                  name={kept ? 'checkmark-circle' : 'ellipse-outline'}
                  size={15}
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
          <View style={styles.titleCenterWrap}>
            <Text style={styles.title}>Buscar duplicados</Text>
            {totalAnalyzed > 0 && !scanning ? (
              <Text style={styles.subtitleText}>{totalAnalyzed} archivos revisados</Text>
            ) : null}
          </View>
          <TouchableOpacity onPress={() => runScan(scanScope)} style={styles.iconBtn} disabled={scanning}>
            <Ionicons name="refresh" size={22} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* Selector de alcance cuando se abre desde una carpeta o álbum */}
        {hasFolderContext && (
          <View style={styles.scopeBar}>
            <TouchableOpacity
              style={[styles.scopeBtn, scanScope === 'folder' && styles.scopeBtnActive]}
              onPress={() => handleSelectScope('folder')}
              disabled={scanning}
              activeOpacity={0.8}
            >
              <Ionicons
                name="folder-open"
                size={15}
                color={scanScope === 'folder' ? '#fff' : theme.colors.textSecondary}
              />
              <Text
                style={[styles.scopeBtnText, scanScope === 'folder' && styles.scopeBtnTextActive]}
                numberOfLines={1}
              >
                {folderName ? `En "${folderName}"` : 'En esta carpeta'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.scopeBtn, scanScope === 'all' && styles.scopeBtnActive]}
              onPress={() => handleSelectScope('all')}
              disabled={scanning}
              activeOpacity={0.8}
            >
              <Ionicons
                name="albums"
                size={15}
                color={scanScope === 'all' ? '#fff' : theme.colors.textSecondary}
              />
              <Text
                style={[styles.scopeBtnText, scanScope === 'all' && styles.scopeBtnTextActive]}
                numberOfLines={1}
              >
                En toda la galería
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {scanning ? (
          <View style={styles.center}>
            {isPaused ? (
              <Ionicons name="pause-circle" size={48} color={theme.colors.warning} />
            ) : (
              <ActivityIndicator size="large" color={theme.colors.primary} />
            )}
            <Text style={styles.info}>
              {isPaused ? `En pausa (${progress || 'Análisis detenido'})` : progress || 'Buscando…'}
            </Text>
            <View style={styles.scanControlsRow}>
              <TouchableOpacity
                style={[styles.scanPauseBtn, isPaused && styles.scanResumeBtn]}
                onPress={() => {
                  if (!scanControlRef.current) return;
                  if (isPaused) scanControlRef.current.resume();
                  else scanControlRef.current.pause();
                }}
                activeOpacity={0.8}
              >
                <Ionicons
                  name={isPaused ? 'play' : 'pause'}
                  size={16}
                  color={isPaused ? '#fff' : theme.colors.warning}
                />
                <Text style={[styles.scanPauseText, isPaused && { color: '#fff' }]}>
                  {isPaused ? 'Reanudar' : 'Pausar'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.scanCancelBtn}
                onPress={() => {
                  if (scanControlRef.current) scanControlRef.current.cancel();
                  onClose();
                }}
                activeOpacity={0.8}
              >
                <Ionicons name="close-circle-outline" size={16} color={theme.colors.danger} />
                <Text style={styles.scanCancelText}>Cancelar</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : scanned && groups.length === 0 ? (
          <View style={styles.center}>
            <Ionicons name="checkmark-done-circle-outline" size={64} color={theme.colors.primary} />
            <Text style={styles.emptyMainTitle}>
              {scanScope === 'folder' && hasFolderContext
                ? 'No hay archivos duplicados en esta carpeta'
                : 'No se encontraron archivos duplicados'}
            </Text>
            <Text style={styles.info}>
              Se analizaron {totalAnalyzed} fotos y videos sin encontrar copias repetidas.
            </Text>
            {scanScope === 'folder' && hasFolderContext && (
              <TouchableOpacity
                style={styles.scanAllGalleryBtn}
                onPress={() => handleSelectScope('all')}
                activeOpacity={0.85}
              >
                <Ionicons name="search" size={18} color="#fff" />
                <Text style={styles.scanAllGalleryBtnText}>
                  Buscar duplicados en toda la galería
                </Text>
              </TouchableOpacity>
            )}
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
              contentContainerStyle={{ padding: 12, paddingBottom: 150 }}
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
          <TouchableOpacity
            style={styles.previewOverlay}
            activeOpacity={1}
            onPress={() => setPreview(null)}
          >
            <Image source={{ uri: preview.uri }} style={styles.previewImage} contentFit="contain" />
            <Text style={styles.previewHint}>
              {preview.filename || ''} {preview.folderLabel ? `(${preview.folderLabel})` : ''} · toca para cerrar
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
    paddingTop: Platform.OS === 'android' ? Math.max((StatusBar.currentHeight || 36) + 14, 50) : 52,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surfaceBorder,
  },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  titleCenterWrap: { alignItems: 'center', flex: 1 },
  title: { color: '#fff', fontSize: 18, fontWeight: '700' },
  subtitleText: { color: theme.colors.textSecondary, fontSize: 11.5, marginTop: 2 },
  scopeBar: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#111827',
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surfaceBorder,
  },
  scopeBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  scopeBtnActive: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primaryLight,
  },
  scopeBtnText: {
    color: theme.colors.textSecondary,
    fontSize: 12.5,
    fontWeight: '700',
  },
  scopeBtnTextActive: {
    color: '#ffffff',
    fontWeight: '800',
  },
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
  emptyMainTitle: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '800',
    marginTop: 14,
    textAlign: 'center',
  },
  info: { color: theme.colors.textSecondary, marginTop: 8, textAlign: 'center', lineHeight: 19 },
  scanAllGalleryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 18,
    backgroundColor: theme.colors.primary,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 12,
  },
  scanAllGalleryBtnText: {
    color: '#ffffff',
    fontSize: 13.5,
    fontWeight: '800',
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: 14,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
    gap: 8,
  },
  cardTitle: { color: '#fff', fontWeight: '700', fontSize: 13.5 },
  matchBadge: {
    backgroundColor: 'rgba(16, 185, 129, 0.16)',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.45)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  matchBadgeCopyName: {
    backgroundColor: 'rgba(56, 189, 248, 0.16)',
    borderColor: 'rgba(56, 189, 248, 0.45)',
  },
  matchBadgeText: {
    color: '#e2e8f0',
    fontSize: 10,
    fontWeight: '800',
  },
  thumbRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  thumbWrap: { width: THUMB },
  thumbBox: { position: 'relative', width: THUMB, height: THUMB },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  thumbKept: { borderColor: theme.colors.primary },
  videoTagPill: {
    position: 'absolute',
    top: 5,
    right: 5,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(0,0,0,0.72)',
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 5,
  },
  videoTagText: { color: '#fff', fontSize: 9, fontWeight: '800' },
  thumbName: { color: '#e2e8f0', fontSize: 10.5, fontWeight: '600', marginTop: 4 },
  thumbFolder: { color: theme.colors.textSecondary, fontSize: 9.5, marginTop: 1 },
  keepBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    marginTop: 5,
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
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'android' ? 52 : 34,
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
    paddingTop: Platform.OS === 'android' ? 48 : 32,
    paddingBottom: Platform.OS === 'android' ? 52 : 32,
    zIndex: 50,
  },
  previewImage: { width: '100%', height: '84%' },
  previewHint: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 8 },
  scanControlsRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 22,
    width: '100%',
    maxWidth: 280,
  },
  scanPauseBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 11,
    borderRadius: 10,
    backgroundColor: 'rgba(245, 158, 11, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.4)',
  },
  scanResumeBtn: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  scanPauseText: {
    color: theme.colors.warning,
    fontSize: 13,
    fontWeight: '700',
  },
  scanCancelBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 11,
    borderRadius: 10,
    backgroundColor: 'rgba(239, 68, 68, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.4)',
  },
  scanCancelText: {
    color: theme.colors.danger,
    fontSize: 13,
    fontWeight: '700',
  },
});
