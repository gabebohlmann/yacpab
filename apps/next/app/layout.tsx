// apps/next/app/layout.tsx
'use client'
import type { Metadata } from 'next'
import { NextTamaguiProvider } from 'app/provider/NextTamaguiProvider'
import { NavigationContainer } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import TabsLayout from './(tabs)/layout'

const Stack = createNativeStackNavigator()

// export const metadata: Metadata = {
//   title: 'Tamagui • App Router',
//   description: 'Tamagui, Solito, Expo & Next.js',
//   icons: '/favicon.ico',
// }

function RootStack() {
  return (
    <Stack.Navigator>
      <Stack.Screen name="(tabs)" component={TabsLayout} />
    </Stack.Navigator>
  )
}
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // You can use `suppressHydrationWarning` to avoid the warning about mismatched content during hydration in dev mode
    <html lang="en" suppressHydrationWarning>
      <body>
        <NextTamaguiProvider>
          <NavigationContainer>
            <RootStack />
            {/* {children} */}
          </NavigationContainer>
        </NextTamaguiProvider>
      </body>
    </html>
  )
}
