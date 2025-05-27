// packages/app/features/about/screen.tsx
'use client'
import { View, Text } from "react-native"
import { useColorScheme } from "react-native"

export function AboutScreen() {
  const colorScheme = useColorScheme()

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: colorScheme === 'dark' ? 'white' : 'black' }}>Account Screen</Text>
    </View>
  )
}