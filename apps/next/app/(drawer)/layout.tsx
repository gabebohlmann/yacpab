// apps/next/app/(drawer)/layout.tsx

'use client'

import React from 'react'
import { createDrawerNavigator, DrawerNavigationOptions } from '@react-navigation/drawer'
import { useNavigation, DrawerActions, useNavigationState } from '@react-navigation/native'
import { Pressable, Text, View, StyleSheet } from 'react-native' // Using react-native for consistency

// Import the TabsLayout which will be a screen in the drawer
// This path assumes your tabs layout is correctly located relative to this file.
// Given your existing tabs layout is at apps/next/app/(drawer)/(tabs)/layout.tsx,
// this means TabsLayout is a child route of this drawer layout.
import TabsLayout from './(tabs)/layout'

// Import the page components for other drawer screens
import SettingsPage from './settings/page'
import OptionsPage from './options/page'

// --- Placeholder Icons (Replace with your actual icon components) ---
const BackIcon = () => <Text style={styles.iconText}>‹ Back</Text>
const HamburgerIcon = () => <Text style={styles.iconText}>☰</Text>
// --- End Placeholder Icons ---

// Custom HeaderLeft Component for the Drawer Navigator
function CustomDrawerHeaderLeft() {
  const navigation = useNavigation() // Drawer's navigation object

  // Get the current route name within the drawer navigator
  const currentRouteName = useNavigationState((state) => {
    if (state === undefined || state.index === undefined || !state.routes[state.index]) {
      return '(tabs)' // Default to '(tabs)' if state is not fully resolved
    }
    return state.routes[state.index].name
  })

  const isTabsScreenActive = currentRouteName === '(tabs)'

  if (!isTabsScreenActive) {
    return (
      <Pressable
        onPress={() => navigation.navigate('(tabs)' as never)} // Navigate to the main tabs screen
        hitSlop={20}
        style={styles.headerButton}
      >
        <BackIcon />
      </Pressable>
    )
  } else {
    return (
      <Pressable
        onPress={() => navigation.dispatch(DrawerActions.toggleDrawer())}
        hitSlop={20}
        style={styles.headerButton}
      >
        <HamburgerIcon />
      </Pressable>
    )
  }
}

const Drawer = createDrawerNavigator()

export default function DrawerLayout() {
  // const colorScheme = useColorScheme(); // For theming if needed

  return (
    <Drawer.Navigator
      initialRouteName="(tabs)" // Start on the screen that contains the tabs
      screenOptions={{
        headerShown: true,
        headerLeft: () => <CustomDrawerHeaderLeft />,
        // Example: Apply general drawer styling
        // drawerStyle: {
        //   backgroundColor: colorScheme === 'dark' ? '#1c1c1e' : '#ffffff',
        // },
        // drawerActiveTintColor: colorScheme === 'dark' ? 'lightblue' : 'blue',
        // drawerInactiveTintColor: colorScheme === 'dark' ? 'gray' : 'darkgray',
      }}
    >
      <Drawer.Screen
        name="(tabs)"
        component={TabsLayout} // Your existing TabsLayout for Next.js
        options={{
          title: 'Vidream', // Title shown in header when (tabs) is active, might be overridden by active tab's title
          drawerLabel: 'Home', // Label for the drawer item if you decide to show it
          // To hide this item from the drawer list (recommended if (tabs) is the main content area):
          drawerItemStyle: { display: 'none' },
        }}
      />
      <Drawer.Screen
        name="settings"
        component={SettingsPage}
        options={{
          title: 'Settings', // Header title for the settings screen
          drawerLabel: 'Settings', // Label in the drawer menu
        }}
      />
      <Drawer.Screen
        name="options"
        component={OptionsPage}
        options={{
          title: 'Options', // Header title for the options screen
          drawerLabel: 'Options', // Label in the drawer menu
        }}
      />
      {/* Add other drawer screens here as needed */}
    </Drawer.Navigator>
  )
}

const styles = StyleSheet.create({
  headerButton: {
    paddingHorizontal: 15,
    justifyContent: 'center',
    height: '100%',
  },
  iconText: {
    fontSize: 18, // Adjust size as needed
    color: '#007AFF', // Example color, align with your theme
  },
  // Styles for placeholder screens if you keep them simple like above
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
