// apps/next/app/(tabs)/layout.tsx
'use client'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import HomePage from './page';
import AccountPage from './account/page';

const Tabs = createBottomTabNavigator();

export default function TabsLayout() {
  return (
    <Tabs.Navigator screenOptions={{ headerShown: false }}>
      <Tabs.Screen
        name="page"
        component={HomePage}
      />
      <Tabs.Screen
        name="account"
        component={AccountPage}
      />
    </Tabs.Navigator>
  )
}
