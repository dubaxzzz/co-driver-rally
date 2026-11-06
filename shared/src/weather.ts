/** Selectable weather. Weather controls light, fog, precipitation and grip. */

export type WeatherId = 'clear' | 'overcast' | 'rain' | 'storm' | 'snow' | 'dusk';

export interface WeatherDef {
  id: WeatherId;
  name: string;
  description: string;
  night: boolean;
  rain: number; // 0..1 rain intensity (streaks + windscreen drops)
  snow: number; // 0..1 snowfall intensity
  fogColor: number;
  fogDensity: number;
  skyTop: number;
  skyBottom: number;
  sunColor: number;
  sunIntensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  /** Multiplies tyre grip on every surface (wet/icy weather < 1). */
  grip: number;
  /** Headlights on by default. */
  headlights: boolean;
}

export const WEATHER: Record<WeatherId, WeatherDef> = {
  clear: {
    id: 'clear', name: 'Clear', description: 'Bright sun, dry roads, long sight lines',
    night: false, rain: 0, snow: 0,
    fogColor: 0xb9c6c9, fogDensity: 0.0035, skyTop: 0x4f86c6, skyBottom: 0xd4dcd8,
    sunColor: 0xfff0d6, sunIntensity: 2.6, hemiSky: 0xcfe3ff, hemiGround: 0x3a4a2a, hemiIntensity: 0.95,
    grip: 1, headlights: false,
  },
  overcast: {
    id: 'overcast', name: 'Overcast', description: 'Flat grey light, damp in places',
    night: false, rain: 0, snow: 0,
    fogColor: 0x8d979b, fogDensity: 0.008, skyTop: 0x6c767c, skyBottom: 0x9aa3a6,
    sunColor: 0xdfe6ea, sunIntensity: 1.1, hemiSky: 0xb7c2c8, hemiGround: 0x3a4237, hemiIntensity: 1.1,
    grip: 0.96, headlights: false,
  },
  rain: {
    id: 'rain', name: 'Rain', description: 'Steady rain – wipers on, grip down',
    night: false, rain: 0.7, snow: 0,
    fogColor: 0x6f787d, fogDensity: 0.013, skyTop: 0x4a5257, skyBottom: 0x737c80,
    sunColor: 0xc8d2d8, sunIntensity: 0.7, hemiSky: 0x9aa6ad, hemiGround: 0x2c332a, hemiIntensity: 1.0,
    grip: 0.85, headlights: true,
  },
  storm: {
    id: 'storm', name: 'Night storm', description: 'Night, heavy rain and fog – trust your co-driver',
    night: true, rain: 0.95, snow: 0,
    fogColor: 0x0a0e12, fogDensity: 0.03, skyTop: 0x05070b, skyBottom: 0x10161c,
    sunColor: 0x7f95c0, sunIntensity: 0.25, hemiSky: 0x3a4a66, hemiGround: 0x0a0d08, hemiIntensity: 0.35,
    grip: 0.8, headlights: true,
  },
  snow: {
    id: 'snow', name: 'Snowfall', description: 'Falling snow, icy patches, low visibility',
    night: false, rain: 0, snow: 0.85,
    fogColor: 0xc9d2d8, fogDensity: 0.016, skyTop: 0x9eabb5, skyBottom: 0xd9e0e4,
    sunColor: 0xe8eef4, sunIntensity: 0.9, hemiSky: 0xdfe8f0, hemiGround: 0x8a949a, hemiIntensity: 1.2,
    grip: 0.78, headlights: true,
  },
  dusk: {
    id: 'dusk', name: 'Dusk', description: 'Low orange sun, long shadows, lights on',
    night: false, rain: 0, snow: 0,
    fogColor: 0x8a6f63, fogDensity: 0.007, skyTop: 0x34406b, skyBottom: 0xe0905a,
    sunColor: 0xffa66b, sunIntensity: 1.6, hemiSky: 0x9a8aa8, hemiGround: 0x2e2a20, hemiIntensity: 0.6,
    grip: 1, headlights: true,
  },
};

export const WEATHER_IDS = Object.keys(WEATHER) as WeatherId[];
export const DEFAULT_WEATHER: WeatherId = 'storm';
