import { deep } from './deep.js';
const C = class { constructor() { return deep(); } };
export const EffectComposer = C, RenderPass = C, UnrealBloomPass = C, ShaderPass = C, OutputPass = C, GLTFLoader = C, KTX2Loader = C, MeshoptDecoder = deep();
