// apps/expo/app/(drawer)/_layout.tsx
import { Drawer } from 'expo-router/drawer'
import { useRouter, useNavigation, useSegments } from 'expo-router' // useSegments can be for logging/debugging now
import { Pressable, Text } from 'react-native'
import { DrawerActions } from '@react-navigation/native' // Correct import for DrawerActions

// --- Placeholder Icons (ensure these are defined or imported) ---
const BackIcon = () => (
  <Text style={{ fontSize: 16, marginLeft: 10, color: '#007AFF' }}>‹ Back</Text>
)
const HamburgerIcon = () => (
  <Text style={{ fontSize: 24, marginLeft: 15, color: '#007AFF' }}>☰</Text>
)
// --- End Placeholder Icons ---

function CustomDrawerHeaderLeft() {
  const router = useRouter()
  // Get the navigation object for the current navigator (which is the Drawer)
  const drawerNavigation = useNavigation()
  const drawerState = drawerNavigation.getState()
  const currentDrawerScreenName = drawerState.routes[drawerState.index]?.name

  const canRouterGoBack = router.canGoBack() // Check global router history

  // For debugging, you can keep this or log these values:
  // const segments = useSegments();
  // console.log('CustomDrawerHeaderLeft:', { currentDrawerScreenName, canRouterGoBack, segments });

  // The logic:
  // If the Drawer's current active screen is NOT the one hosting the tabs (i.e., "(tabs)"),
  // AND the global router has a history to go back to, then show the back button.
  if (currentDrawerScreenName !== '(tabs)' && canRouterGoBack) {
    return (
      <Pressable
        onPress={() => router.back()}
        hitSlop={20}
        style={{ paddingLeft: 5, paddingRight: 10, justifyContent: 'center', height: '100%' }}
      >
        <BackIcon />
      </Pressable>
    )
  } else {
    // Otherwise (either on the (tabs) screen or cannot go back), show the hamburger menu.
    return (
      <Pressable
        onPress={() => drawerNavigation.dispatch(DrawerActions.toggleDrawer())}
        hitSlop={20}
        style={{ paddingLeft: 5, paddingRight: 10, justifyContent: 'center', height: '100%' }}
      >
        <HamburgerIcon />
      </Pressable>
    )
  }
}

export default function AppDrawerLayout() {
  return (
    <Drawer
      screenOptions={{
        headerShown: true,
        headerLeft: () => <CustomDrawerHeaderLeft />,
      }}
    >
      <Drawer.Screen
        name="(tabs)" // This is the screen in the Drawer that renders your Tab navigator
        options={{
          // The title displayed in the header when (tabs) is active will
          // actually come from the active tab screen's options inside app/(app)/(tabs)/_layout.tsx.
          // This 'title' is more of a fallback or for the drawer item label if it were visible.
          title: 'Vidream', // General title for the group
          drawerItemStyle: { display: 'none' },
        }}
      />
      <Drawer.Screen
        name="settings" // Path: app/(app)/settings.tsx
        options={{
          drawerLabel: 'Settings',
          title: 'Settings',
        }}
      />
      <Drawer.Screen
        name="options" // Path: app/(app)/options.tsx (ensure this file exists)
        options={{
          drawerLabel: 'Options',
          title: 'Options',
        }}
      />
    </Drawer>
  )
}
// // apps/expo/app/(app)/(drawer)/_layout.tsx
// import { Drawer } from 'expo-router/drawer';

// export default function AppDrawerLayout() {
//   return (
//     <Drawer
//       screenOptions={{
//         headerShown: true,
//       }}
//     >
//       <Drawer.Screen
//         name="(tabs)"
//         options={{
//           title: 'Vidream',
//           drawerItemStyle: { display: 'none' },
//         }}
//       />
//       <Drawer.Screen
//         name="settings"
//         options={{
//           drawerLabel: 'Settings',
//           title: 'Settings',
//         }}
//       />
//       <Drawer.Screen
//         name="options"
//         options={{
//           drawerLabel: 'Options',
//           title: 'Options',
//         }}
//       />
//     </Drawer>
//   )
// }
