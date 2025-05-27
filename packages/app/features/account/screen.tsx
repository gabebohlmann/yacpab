// packages/app/features/account/screen.tsx
'use client'
import { View, Text } from "react-native"
import { useColorScheme } from "react-native"

export function AccountScreen() {
  const colorScheme = useColorScheme()

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: colorScheme === 'dark' ? 'white' : 'black' }}>Account Screen</Text>
    </View>
  )
}