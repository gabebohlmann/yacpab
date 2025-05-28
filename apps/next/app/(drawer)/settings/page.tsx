// apps/next/app/(drawer)/settings/page.tsx
'use client'

import { View, Text, StyleSheet } from 'react-native' // Or use web equivalents

export default function SettingsPage() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Settings Page (Next.js)</Text>
      {/* Your settings content here */}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
  },
})