import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';

export default function PermissionScreen({ onRequestPermission, onOpenSettings }) {
  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <View style={styles.iconCircle}>
          <Ionicons name="images" size={48} color={theme.colors.primary} />
        </View>

        <Text style={styles.title}>Acceso a tus fotos</Text>
        <Text style={styles.description}>
          Para mostrar tus imágenes, videos y álbumes, la aplicación necesita permiso de acceso a la memoria de tu dispositivo.
        </Text>

        <TouchableOpacity
          style={styles.button}
          onPress={onRequestPermission}
          activeOpacity={0.8}
        >
          <Ionicons name="shield-checkmark-outline" size={20} color="#ffffff" style={styles.buttonIcon} />
          <Text style={styles.buttonText}>Permitir acceso</Text>
        </TouchableOpacity>

        {onOpenSettings && (
          <TouchableOpacity
            style={[styles.button, { marginTop: 12, backgroundColor: theme.colors.surfaceHover }]}
            onPress={onOpenSettings}
            activeOpacity={0.8}
          >
            <Ionicons name="settings-outline" size={20} color="#ffffff" style={styles.buttonIcon} />
            <Text style={styles.buttonText}>Abrir ajustes de permisos</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.xl,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing.xl,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    width: '100%',
    maxWidth: 360,
  },
  iconCircle: {
    width: 90,
    height: 90,
    borderRadius: 45,
    backgroundColor: theme.colors.surfaceHover,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.primaryDark,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: theme.colors.textPrimary,
    marginBottom: theme.spacing.sm,
    textAlign: 'center',
  },
  description: {
    fontSize: 14,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: theme.spacing.xl,
  },
  button: {
    backgroundColor: theme.colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: theme.borderRadius.md,
    width: '100%',
  },
  buttonIcon: {
    marginRight: 8,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
});
