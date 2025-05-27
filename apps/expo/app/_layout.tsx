// apps/expo/app/_layout.tsx
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { useFonts } from 'expo-font';
import { SplashScreen, Stack } from 'expo-router';
import { Provider } from 'app/provider'; // Assuming this is your Tamagui provider or similar
import { NativeToast } from '@my/ui/src/NativeToast'; // Assuming this is your toast component

// Import navigation configuration
import { getRootStackConfig, TabNavigatorLayoutConfig, ScreenConfig } from 'app/features/navigation/layout';

export const unstable_settings = {
  // Ensure that reloading on any screen within a nested navigator still presents
  // the parent navigator's UI (e.g., a back button).
  // initialRouteName: '(tabs)', // This can also be set in the Stack navigator options from config
};

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

export default function RootLayoutNav() {
  const colorScheme = useColorScheme();
  const [fontsLoaded, fontError] = useFonts({
    // Inter: require('@tamagui/font-inter/otf/Inter-Medium.otf'),
    // InterBold: require('@tamagui/font-inter/otf/Inter-Bold.otf'),
    // Add your fonts here if needed
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  // Don't render anything until fonts are loaded or an error occurs
  if (!fontsLoaded && !fontError) {
    return null;
  }

  const rootStackConfig = getRootStackConfig();

  if (!rootStackConfig) {
    // Handle the case where configuration is not found, though it should always be there.
    // You could render an error message or a fallback.
    console.error("Root stack configuration not found!");
    return null;
  }

  return (
    <Provider>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <Stack
          initialRouteName={rootStackConfig.initialRouteName}
          screenOptions={rootStackConfig.options} // Apply global stack options
        >
          {rootStackConfig.screens.map((screenOrNavigator) => {
            // If it's a TabNavigator configuration, create a Stack.Screen for the group
            if (screenOrNavigator.type === 'tabs') {
              const tabNavConfig = screenOrNavigator as TabNavigatorLayoutConfig;
              return (
                <Stack.Screen
                  key={tabNavConfig.name}
                  name={tabNavConfig.name} // e.g., "(tabs)"
                  options={tabNavConfig.options} // Options for the tab group screen in stack
                />
              );
            }
            // If it's a regular Screen configuration
            const screenConfig = screenOrNavigator as ScreenConfig;
            return (
              <Stack.Screen
                key={screenConfig.name}
                name={screenConfig.name} // Name of the screen file (e.g., "UserProfile")
                options={screenConfig.options}
                // For Expo Router, the component is resolved via file-based routing.
                // The `component` prop in ScreenConfig is not directly used here for `Stack.Screen`
                // unless you are defining screens that don't map to files (less common for root).
              />
            );
          })}
        </Stack>
        <NativeToast />
      </ThemeProvider>
    </Provider>
  );
}
