// apps/expo/app/_layout.tsx
import { useEffect } from 'react'
import { useColorScheme } from 'react-native'
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native'
import { useFonts } from 'expo-font'
import { SplashScreen, Stack } from 'expo-router' // Import Stack instead of Drawer
import { Provider } from 'app/provider'
import { NativeToast } from '@my/ui/src/NativeToast'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

SplashScreen.preventAutoHideAsync()

export default function RootStackLayout() {
  // Renamed to reflect it's a Stack
  const colorScheme = useColorScheme()
  const [fontsLoaded, fontError] = useFonts({
    // Your fonts
  })

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync()
    }
  }, [fontsLoaded, fontError])

  if (!fontsLoaded && !fontError) {
    return null
  }

  return (
    <Provider>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <Stack
            screenOptions={{
              headerShown: false,
            }}
          >
            <Stack.Screen name="(drawer)" />
          </Stack>
          <NativeToast />
        </GestureHandlerRootView>
      </ThemeProvider>
    </Provider>
  )
}

// import { useEffect } from 'react';
// import { useColorScheme } from 'react-native';
// import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
// import { useFonts } from 'expo-font';
// import { SplashScreen } from 'expo-router';
// import { Provider } from 'app/provider';
// import { NativeToast } from '@my/ui/src/NativeToast';
// import { GestureHandlerRootView } from 'react-native-gesture-handler';
// import { Drawer } from 'expo-router/drawer';

// SplashScreen.preventAutoHideAsync();

// export default function RootLayoutNav() {
//   const colorScheme = useColorScheme();
//   const [fontsLoaded, fontError] = useFonts({
//     // Your fonts
//   });

//   useEffect(() => {
//     if (fontsLoaded || fontError) {
//       SplashScreen.hideAsync();
//     }
//   }, [fontsLoaded, fontError]);

//   if (!fontsLoaded && !fontError) {
//     return null;
//   }

//   return (
//     <Provider>
//       <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
//         <GestureHandlerRootView style={{ flex: 1 }}>
//           <Drawer
//             screenOptions={{
//               headerShown: true, // Drawer provides the global header
//             }}
//           >
//             <Drawer.Screen
//               name="(tabs)" // This is your tab group, corresponds to app/(tabs)/_layout.tsx
//               options={{
//                 title: 'Home',
//                 drawerItemStyle: { display: 'none' },
//               }}
//             />
//             <Drawer.Screen
//               name="drawer"
//               options={{
//                 drawerLabel: 'Drawer',
//                 title: 'Drawer',
//               }}
//             />
//             {/* <Drawer.Screen
//               name="drawer/settings"
//               options={{
//                 drawerLabel: 'Settings',
//                 title: 'Settings',
//               }}
//             /> */}
//           </Drawer>
//           <NativeToast />
//         </GestureHandlerRootView>
//       </ThemeProvider>
//     </Provider>
//   )
// }

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// import { useEffect } from 'react'
// import { useColorScheme } from 'react-native'
// import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native'
// import { useFonts } from 'expo-font'
// import { SplashScreen, Stack } from 'expo-router'
// import { Provider } from 'app/provider' // Assuming this is your Tamagui provider or similar
// import { NativeToast } from '@my/ui/src/NativeToast' // Assuming this is your toast component
// import { GestureHandlerRootView } from 'react-native-gesture-handler'
// import { Drawer } from 'expo-router/drawer'

// // Import navigation configuration
// import {
//   getRootStackConfig,
//   TabNavigatorLayoutConfig,
//   ScreenConfig,
// } from 'app/features/navigation/layout'

// export const unstable_settings = {
//   // Ensure that reloading on any screen within a nested navigator still presents
//   // the parent navigator's UI (e.g., a back button).
//   // initialRouteName: '(tabs)', // This can also be set in the Stack navigator options from config
// }

// // Prevent the splash screen from auto-hiding before asset loading is complete.
// SplashScreen.preventAutoHideAsync()

// export default function RootLayoutNav() {
//   const colorScheme = useColorScheme()
//   const [fontsLoaded, fontError] = useFonts({
//     // Inter: require('@tamagui/font-inter/otf/Inter-Medium.otf'),
//     // InterBold: require('@tamagui/font-inter/otf/Inter-Bold.otf'),
//     // Add your fonts here if needed
//   })

//   useEffect(() => {
//     if (fontsLoaded || fontError) {
//       SplashScreen.hideAsync()
//     }
//   }, [fontsLoaded, fontError])

//   // Don't render anything until fonts are loaded or an error occurs
//   if (!fontsLoaded && !fontError) {
//     return null
//   }

//   const rootStackConfig = getRootStackConfig()

//   if (!rootStackConfig) {
//     // Handle the case where configuration is not found, though it should always be there.
//     // You could render an error message or a fallback.
//     console.error('Root stack configuration not found!')
//     return null
//   }

//   return (
//     <Provider>
//       <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
//         <GestureHandlerRootView style={{ flex: 1 }}>
//           <Drawer>
//             <Drawer.Screen
//               name="drawer/settings" // This is the name of the page and must match the url from root
//               options={{
//                 drawerLabel: 'Settings',
//                 title: 'settings',
//               }}
//             />

//             <Stack
//               initialRouteName={rootStackConfig.initialRouteName}
//               screenOptions={rootStackConfig.options} // Apply global stack options
//             >
//               {rootStackConfig.screens.map((screenOrNavigator) => {
//                 // If it's a TabNavigator configuration, create a Stack.Screen for the group
//                 if (screenOrNavigator.type === 'tabs') {
//                   const tabNavConfig = screenOrNavigator as TabNavigatorLayoutConfig
//                   return (
//                     <Stack.Screen
//                       key={tabNavConfig.name}
//                       name={tabNavConfig.name} // e.g., "(tabs)"
//                       options={tabNavConfig.options} // Options for the tab group screen in stack
//                     />
//                   )
//                 }
//                 // If it's a regular Screen configuration
//                 const screenConfig = screenOrNavigator as ScreenConfig
//                 return (
//                   <Stack.Screen
//                     key={screenConfig.name}
//                     name={screenConfig.name} // Name of the screen file (e.g., "UserProfile")
//                     options={screenConfig.options}
//                     // For Expo Router, the component is resolved via file-based routing.
//                     // The `component` prop in ScreenConfig is not directly used here for `Stack.Screen`
//                     // unless you are defining screens that don't map to files (less common for root).
//                   />
//                 )
//               })}
//             </Stack>
//           </Drawer>
//           <NativeToast />
//         </GestureHandlerRootView>
//       </ThemeProvider>
//     </Provider>
//   )
// }
