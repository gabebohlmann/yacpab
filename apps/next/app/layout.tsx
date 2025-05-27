// apps/next/app/layout.tsx
'use client' // Required for Next.js App Router with client components

import React, { useEffect } from 'react' // useEffect for potential client-side only logic
import { useColorScheme } from 'react-native' // If you use this for theming
import { NavigationContainer, DarkTheme, DefaultTheme } from '@react-navigation/native'
import {
  createNativeStackNavigator,
  NativeStackNavigationOptions,
} from '@react-navigation/native-stack'
import { NextTamaguiProvider } from 'app/provider/NextTamaguiProvider' // Your Tamagui provider

// Import navigation configuration
import {
  getRootStackConfig,
  TabNavigatorLayoutConfig,
  ScreenConfig,
} from 'app/features/navigation/layout'
import TabsLayout from './(tabs)/layout' // This assumes Next.js resolves this path to the tabs layout component

const Stack = createNativeStackNavigator()

// This component will represent the content of the "(tabs)" route in the StackNavigator
// It effectively renders your apps/next/app/(tabs)/layout.tsx
const TabsPlaceholderComponent = () => {
  // The actual rendering is handled by Next.js file-system routing for the '(tabs)' group
  // and its layout.tsx. This component is just a placeholder for React Navigation's stack.
  // However, to make React Navigation happy, it needs *a* component.
  // The actual content will be rendered by Next.js's own router for the / (tabs) path.
  // This is a bit of a conceptual bridge.
  // A cleaner way if TabsLayout is a self-contained React Navigation navigator:
  return <TabsLayout />
}

function RootStackNavigator() {
  const rootStackConfig = getRootStackConfig()

  if (!rootStackConfig) {
    console.error('Root stack configuration not found for Next.js!')
    return null // Or some fallback UI
  }

  return (
    <Stack.Navigator
      initialRouteName={rootStackConfig.initialRouteName}
      screenOptions={rootStackConfig.options as NativeStackNavigationOptions}
    >
      {rootStackConfig.screens.map((screenOrNavigator) => {
        if (screenOrNavigator.type === 'tabs') {
          const tabNavConfig = screenOrNavigator as TabNavigatorLayoutConfig
          return (
            <Stack.Screen
              key={tabNavConfig.name}
              name={tabNavConfig.name} // e.g., "(tabs)"
              component={TabsPlaceholderComponent} // Next.js App Router handles rendering (tabs)/layout.tsx
              options={tabNavConfig.options as NativeStackNavigationOptions}
            />
          )
        }
        // If it's a regular Screen configuration
        const screenConfig = screenOrNavigator as ScreenConfig
        // For Next.js, each stack screen not part of tabs would typically be its own page
        // e.g., app/UserProfile/page.tsx. The `component` prop here would point to that page component.
        // This requires that `screenConfig.component` is the actual page component.
        // Ensure your `app/features/navigation/layout.ts` imports the correct Next.js page components
        // or the shared screens if your Next.js pages are simple wrappers.
        // For example, if UserProfileScreen is a shared component, you'd have:
        // app/UserProfile/page.tsx:
        // import { UserProfileScreen } from 'app/features/userProfile/screen';
        // export default UserProfileScreen;
        // And in layout.ts, component would be UserProfileScreen.
        return (
          <Stack.Screen
            key={screenConfig.name}
            name={screenConfig.name}
            component={screenConfig.component} // This should be the Next.js page component
            options={screenConfig.options as NativeStackNavigationOptions}
          />
        )
      })}
    </Stack.Navigator>
  )
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const colorScheme = useColorScheme() // Or your theme management logic

  // The `children` prop is generally not directly used here when NavigationContainer
  // manages the entire screen. Next.js App router will render the matched page
  // within the structure defined by RootStackNavigator.
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <NextTamaguiProvider>
          <NavigationContainer theme={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
            <RootStackNavigator />
            {/* children prop might not be needed here if NavigationContainer is the root view */}
            {/* If you have content outside NavigationContainer, place it here. */}
          </NavigationContainer>
        </NextTamaguiProvider>
      </body>
    </html>
  )
}
