// apps/expo/app/(tabs)/_layout.tsx
import { Tabs } from 'expo-router'
import { Text } from 'react-native'

export default function TabsLayout() {
  return (
    <Tabs>
      <Tabs.Screen name="index" />
      <Tabs.Screen name="account" />
    </Tabs>
  )
}
