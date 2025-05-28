// apps/expo/app/(app)/(tabs)/_layout.tsx
import { Tabs } from 'expo-router'
import { Text, useColorScheme } from 'react-native' // For icon rendering

// Import navigation configuration and icon component
import {
  findNavigatorLayout,
  TabNavigatorLayoutConfig,
  PlaceholderIcon,
} from 'app/features/navigation/layout'

// This is a simple TabBarIcon component.
// In a real app, you'd use a proper icon library like @expo/vector-icons
// and map `iconName` to the actual icon.
const TabBarIcon = (props: { name?: string; focused: boolean; color: string }) => {
  if (!props.name) return null
  return (
    <PlaceholderIcon name={props.name} color={props.color} size={props.focused ? 26 : 24} />
    // Example with a hypothetical Icon library:
    // import { Ionicons } from '@expo/vector-icons';
    // return <Ionicons name={props.name as any} size={24} color={props.color} />;
  )
}

export default function TabLayout() {
  const colorScheme = useColorScheme()
  // Find the tab navigator configuration. The name '(tabs)' is by convention.
  const tabsConfig = findNavigatorLayout('(tabs)') as TabNavigatorLayoutConfig | undefined

  if (!tabsConfig || tabsConfig.type !== 'tabs') {
    console.error("Tabs configuration '(tabs)' not found or is not a tab navigator!")
    // Fallback or error display
    return <Text>Error: Tabs configuration missing.</Text>
  }

  return (
    <Tabs
      initialRouteName={tabsConfig.initialRouteName}
      screenOptions={{
        // Global options for all tabs from the config
        ...(tabsConfig.options as any), // Cast because Expo's TabNavigationOptions is specific
        // Example of theme-dependent tab bar styling:
        // tabBarActiveTintColor: colorScheme === 'dark' ? 'lightblue' : 'blue',
        // tabBarStyle: { backgroundColor: colorScheme === 'dark' ? '#333' : '#FFF' },
      }}
    >
      {tabsConfig.screens.map((screenConfig) => (
        <Tabs.Screen
          key={screenConfig.name}
          name={screenConfig.name} // This name must match the file name in (tabs)/ e.g., "index.tsx", "account.tsx"
          options={{
            ...(screenConfig.options as any), // Options specific to this tab screen
            tabBarIcon: ({ focused, color }) => (
              <TabBarIcon
                name={screenConfig.options?.tabBarIconName}
                focused={focused}
                color={color}
              />
            ),
            // Example: headerShown: screenConfig.options?.headerShown ?? false,
            // title: screenConfig.options?.title,
          }}
        />
      ))}
    </Tabs>
  )
}