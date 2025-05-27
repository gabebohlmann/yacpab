// packages/app/features/home/screen.tsx
'use client'
import { View, Text } from "react-native"
import { useColorScheme } from "react-native"

export function HomeScreen() {
  const colorScheme = useColorScheme()
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: colorScheme === 'dark' ? 'white' : 'black' }}>Home Screen</Text>
    </View>
  )
}