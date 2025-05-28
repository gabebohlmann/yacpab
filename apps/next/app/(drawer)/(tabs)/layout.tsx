// apps/next/app/(drawer)/(tabs)/layout.tsx
'use client'

import React from 'react'
import { createBottomTabNavigator, BottomTabNavigationOptions } from '@react-navigation/bottom-tabs'
import { useColorScheme } from 'react-native' // For theming icons or tab bar

// Import navigation configuration and icon component
import {
  findNavigatorLayout,
  TabNavigatorLayoutConfig,
  PlaceholderIcon,
  ScreenConfig,
} from 'app/features/navigation/layout'

// Import the actual page components that these tabs will render.
// These should correspond to the `component` specified in your `layout.ts`
// or be simple wrappers around your shared screen components.
// For Next.js, these are typically the default exports of your `page.tsx` files.
// Example:
// import HomePage from './page'; // for 'index' route
// import AccountPage from './account/page'; // for 'account' route
// The `screenConfig.component` from `layout.ts` will be used directly.
// Ensure these components are Next.js page components.

const Tab = createBottomTabNavigator()

// This is a simple TabBarIcon component.
// In a real app, you'd use a proper icon library or custom SVGs.
const TabBarIcon = (props: { name?: string; focused: boolean; color: string; size: number }) => {
  if (!props.name) return null
  return (
    <PlaceholderIcon
      name={props.name}
      color={props.color}
      size={props.focused ? props.size + 2 : props.size}
    />
    // Example with a hypothetical Icon library:
    // import { Ionicons } from '@expo/vector-icons'; // Ensure this works in React Native Web
    // return <Ionicons name={props.name as any} size={props.size} color={props.color} />;
  )
}

export default function TabsLayout() {
  const colorScheme = useColorScheme()
  const tabsConfig = findNavigatorLayout('(tabs)') as TabNavigatorLayoutConfig | undefined

  if (!tabsConfig || tabsConfig.type !== 'tabs') {
    console.error("Tabs configuration '(tabs)' not found or is not a tab navigator for Next.js!")
    // Fallback or error display
    return <div>Error: Tabs configuration missing.</div>
  }

  return (
    <Tab.Navigator
      initialRouteName={tabsConfig.initialRouteName}
      {...tabsConfig.tabNavigatorOptions}
      screenOptions={({ route }) => ({
        // Global options from config
        ...(tabsConfig.tabScreenOptions as BottomTabNavigationOptions),
        // Icon rendering logic
        tabBarIcon: ({ focused, color, size }) => {
          const screen = tabsConfig.screens.find((s) => s.name === route.name)
          return (
            <TabBarIcon
              name={screen?.options?.tabBarIconName}
              focused={focused}
              color={color}
              size={size}
            />
          )
        },
        // Example of theme-dependent styling
        // tabBarActiveTintColor: colorScheme === 'dark' ? 'lightblue' : 'blue',
        //TODO: Figure out why web has glitches with themeing, currently must start app and then comment out <Provider> in NextTamaguiProvider.tsx              ,..,,,,,,,,
        // tabBarStyle: { backgroundColor: colorScheme === 'dark' ? '#121212' : '#FFFFFF' },
      })}
    >
      {tabsConfig.screens.map((screenConfig: ScreenConfig) => {
        // For Next.js, `screenConfig.component` should be the actual page component
        // that Next.js would render for that route.
        // e.g., if name is 'index', component should be the one from `app/(tabs)/page.tsx`.
        // Ensure your `layout.ts` `component` fields for tab screens point to these
        // Next.js page components or the shared screens if pages are simple wrappers.
        // For example, if `app/(tabs)/page.tsx` is:
        //   import { HomeScreen } from 'app/features/home/screen'; export default HomeScreen;
        // then `screenConfig.component` (HomeScreen) is correct.
        return (
          <Tab.Screen
            key={screenConfig.name}
            name={screenConfig.name} // e.g., "index", "account"
            component={screenConfig.component} // The actual React component for the screen
            options={{
              ...(screenConfig.options as BottomTabNavigationOptions),
              // title: screenConfig.options?.title, // Already handled by spread
              // headerShown: screenConfig.options?.headerShown, // Already handled
            }}
          />
        )
      })}
    </Tab.Navigator>
  )
}
