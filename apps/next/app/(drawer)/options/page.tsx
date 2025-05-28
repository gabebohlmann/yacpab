// apps/next/app/(drawer)/options/page.tsx
'use client'

import { View, Text, StyleSheet } from 'react-native' // Or use web equivalents

export default function OptionsPage() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Options Page (Next.js)</Text>
      {/* Your options content here */}
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