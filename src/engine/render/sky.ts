import * as THREE from 'three'

/**
 * Vertical gradient sky implemented as a large inverted sphere.
 * Cheap (no atmospheric scattering), looks fine for an arcade racer, and
 * provides clear visual separation between sea and horizon.
 */
export function createSkyDome(): THREE.Mesh {
  // Custom shader — gradient between top color and horizon color along world-Y.
  const topColor = new THREE.Color(0x0a1a30) // deep blue
  const horizonColor = new THREE.Color(0xa6c8e8) // hazy pale blue
  const sunGlow = new THREE.Color(0xffd9a8)

  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTopColor: { value: topColor },
      uHorizonColor: { value: horizonColor },
      uSunDir: { value: new THREE.Vector3(0.5, 0.45, 0.7).normalize() },
      uSunColor: { value: sunGlow },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldDir;
      void main() {
        vWorldDir = normalize((modelMatrix * vec4(position, 1.0)).xyz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTopColor;
      uniform vec3 uHorizonColor;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      varying vec3 vWorldDir;
      void main() {
        // Smooth gradient from horizon (y≈0) to top (y≈1).
        float h = clamp(vWorldDir.y, 0.0, 1.0);
        vec3 col = mix(uHorizonColor, uTopColor, pow(h, 0.55));
        // Subtle sun glow near the horizon in the sun direction.
        float sun = max(dot(vWorldDir, uSunDir), 0.0);
        col += uSunColor * pow(sun, 8.0) * 0.45;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  })

  // Big enough to encompass the whole arena (water is 800m wide).
  const geom = new THREE.SphereGeometry(2000, 32, 16)
  const mesh = new THREE.Mesh(geom, material)
  mesh.name = 'sky'
  mesh.frustumCulled = false
  return mesh
}
