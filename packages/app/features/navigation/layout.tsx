// packages/app/features/navigation/layout.tsx
import { ComponentType } from 'react'
import { Text } from 'react-native' // For placeholder icon
// Import shared screen components
import { HomeScreen } from '../home/screen'
import { AccountScreen } from '../account/screen'
import { SettingsScreen } from '../settings/screen';

// --- Configuration Types ---

/**
 * Generic options applicable to any screen in any navigator.
 */
export interface ScreenOptionsConfig {
  title?: string
  headerShown?: boolean
  tabBarIconName?: string // Used for tab icons
  // Add other common React Navigation/Expo Router options as needed
  // e.g., presentation: 'modal' for stack screens
}

/**
 * Configuration for a single screen.
 */
export interface ScreenConfig {
  name: string
  component: ComponentType<any> // TODO: Consider a more specific type if possible
  options?: ScreenOptionsConfig // Options specific to this screen
}

/**
 * Options specific to the Tab.Navigator component itself (e.g., tab bar styling).
 * These are props that would be passed directly to the <Tab.Navigator> component.
 */
export interface TabNavigatorOwnOptions {
  tabBarActiveTintColor?: string
  tabBarInactiveTintColor?: string
  tabBarStyle?: object // Should be StyleProp<ViewStyle> in practice
  // Add other Tab.Navigator direct props like backBehavior, sceneContainerStyle, etc.
  // Example:
  // backBehavior?: 'firstRoute' | 'initialRoute' | 'order' | 'history' | 'none';
  // sceneContainerStyle?: object; // StyleProp<ViewStyle>
}

/**
 * Default screen options for screens *within* a TabNavigator.
 * These are passed to the `screenOptions` prop of the <Tab.Navigator>.
 */
export interface TabNavigatorScreenOptions extends ScreenOptionsConfig {
  // Add any tab-specific screen options if they differ from general ScreenOptionsConfig
  // For example, tabBarLabel, tabBarBadge, etc. could be defaulted here.
}

/**
 * Configuration for a Tab Navigator.
 */
export interface TabNavigatorLayoutConfig {
  type: 'tabs'
  name: string // Name of the tab group (e.g., '(tabs)')
  initialRouteName?: string
  screens: ScreenConfig[]

  /** Options for this TabNavigator when it acts as a screen in a parent StackNavigator. */
  stackScreenOptions?: ScreenOptionsConfig // e.g., { headerShown: false } for the (tabs) group in RootStack

  /** Options for the <Tab.Navigator> component itself (e.g., tab bar styling). */
  tabNavigatorOptions?: TabNavigatorOwnOptions

  /** Default options for all screens *within* this TabNavigator (passed to <Tab.Navigator screenOptions={...}>). */
  tabScreenOptions?: TabNavigatorScreenOptions // e.g., { headerShown: true } for all tab screens
}

/**
 * Configuration for a Stack Navigator.
 */
export interface StackNavigatorLayoutConfig {
  type: 'stack'
  name: string
  initialRouteName?: string
  screens: (ScreenConfig | TabNavigatorLayoutConfig)[]
  /** Default options for all screens *within* this StackNavigator, and for the navigator itself if nested. */
  options?: ScreenOptionsConfig & {
    // Add StackNavigator-specific options for the navigator itself
  }
}

export type NavigatorLayout = StackNavigatorLayoutConfig | TabNavigatorLayoutConfig

// --- Main Navigation Structure ---
export const appNavigationStructure: NavigatorLayout[] = [
  {
    type: 'stack',
    name: 'Root',
    initialRouteName: '(tabs)',
    options: { headerShown: false }, // Hides header for the Root Stack itself
    screens: [
      {
        type: 'tabs',
        name: '(tabs)',
        initialRouteName: 'index',
        stackScreenOptions: {
          // Options for how '(tabs)' group appears in 'Root' Stack
          headerShown: false, // Header for the '(tabs)' group itself is hidden
        },
        tabNavigatorOptions: {
          // Options for the <Tab.Navigator> component
          // Example: tabBarActiveTintColor: 'dodgerblue',
        },
        tabScreenOptions: {
          // Default options for screens *inside* this TabNavigator
          headerShown: true, // Headers for 'index', 'account' screens will be shown by default
        },
        screens: [
          {
            name: 'index',
            component: HomeScreen,
            options: {
              title: 'Home',
              tabBarIconName: 'home',
              // headerShown: false, // Example: could override tabScreenOptions.headerShown for this specific tab
            },
          },
          {
            name: 'account',
            component: AccountScreen,
            options: {
              title: 'Account',
              tabBarIconName: 'person',
            },
          },
          {
            name: 'settings',
            component: SettingsScreen, // Assuming SettingsScreen is imported
            options: { title: 'Settings', tabBarIconName: 'settings' },
          },
        ],
      },
      // Example of another stack screen outside tabs
      // {
      //   name: 'UserProfile',
      //   component: UserProfileScreen, // Assuming UserProfileScreen is imported
      //   options: { title: 'Profile', headerShown: true },
      // },
    ],
  },
]

// --- Helper Functions ---
export const findNavigatorLayout = (
  name: string,
  structure: (NavigatorLayout | ScreenConfig)[] = appNavigationStructure
): NavigatorLayout | ScreenConfig | undefined => {
  for (const item of structure) {
    if (item.name === name) return item
    if ('screens' in item && Array.isArray(item.screens)) {
      const foundInScreens = findNavigatorLayout(name, item.screens)
      if (foundInScreens) return foundInScreens
    }
  }
  return undefined
}

export const getRootStackConfig = (): StackNavigatorLayoutConfig | undefined => {
  return appNavigationStructure.find((nav) => nav.type === 'stack' && nav.name === 'Root') as
    | StackNavigatorLayoutConfig
    | undefined
}

export const PlaceholderIcon = ({
  name,
  color,
  size,
}: {
  name?: string
  color: string
  size: number
}) => {
  if (!name) return null
  return (
    <Text style={{ color, fontSize: size, fontWeight: 'bold' }}>
      {name.substring(0, 2).toUpperCase()}
    </Text>
  )
}
