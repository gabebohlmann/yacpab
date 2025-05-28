// apps/expo/types.d.ts
// apps/expo/app/types.d.ts
import { config } from '@my/config'

export type Conf = typeof config

declare module '@my/ui' {
  interface TamaguiCustomConfig extends Conf {}
}
