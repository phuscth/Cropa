# Art direction

The background frames a screenshot like a polished product shot: calm, deep, softly lit, one idea done well. Follow these rules within the module contract; the contract wins where they meet.

## Composition
- The screenshot is the hero. Keep what shows around scene.frame calm near its edges: low contrast, little detail, no fast motion. Put interest in the margins: objects that tuck behind the frame or peek past a corner, a glow that spills out from behind it.
- Light the card: a soft glow behind the frame or off one corner, so it reads as lit.
- One motif, few elements, big differences in scale: a few large shapes, some medium, a scattering of small ones. Leave empty space.

## Layers, back to front
1. Base: a gradient (3+ stops) or soft field over the whole canvas, never one flat fill.
2. Large soft shapes: 3 to 6 blurred blobs, bands or ribbons, 30 to 80% of min(width, height).
3. Light: radial glows composited with globalCompositeOperation 'lighter' or 'screen'.
4. Detail: a sparse set of small sharp elements (motes, stars, sparks) of varied size and alpha.
5. Finish: film grain, then a vignette (a radial gradient to rgba(0,0,0,0.25-0.4) at the corners).

## Colour
- Derive tones from scene.palette: a dark base (the darkest colour mixed toward black), a mid tone, a light and one accent (the most saturated). Mix colours in RGB; do not lay raw palette colours side by side as flat fills.
- Real value contrast: dark edges, the lightest values near the light, a 3 to 4 step ramp.
- At most one saturated accent; everything else muted. No hue cycling, no rainbow, no pure #f00/#0f0/#00f.
- An empty or grey palette: choose a calm scheme yourself (deep navy, slate, warm amber).

## Light and depth
- Glow: createRadialGradient with 3+ stops and alpha falling to 0.
- Blur cheaply: paint soft layers on an OffscreenCanvas at 1/4 to 1/8 size, then ctx.drawImage it scaled to full size with imageSmoothingQuality 'high'. ctx.filter = 'blur(Npx)' only for a few small shapes; set it back to 'none'.
- Depth: far elements smaller, softer, dimmer and tinted toward the base; near ones larger and either sharp or very soft (bokeh: a disc with a slightly brighter rim). Near layers move more (parallax).
- Shadows are soft and wide (shadowBlur, or a blurred dark ellipse), never hard black.

## Texture and the frame budget
- Grain: once, build a 256x256 seeded noise tile (createImageData + putImageData), then each frame fill with ctx.createPattern(tile, 'repeat'), globalAlpha 0.05-0.12, 'overlay' or 'soft-light'.
- Organic shapes: a small seeded value-noise or sum of sines, sampled at tens to hundreds of points. Never a per-pixel loop over the full canvas in a frame.
- An OffscreenCanvas you draw on keeps its drawing between frames: call its context's reset() before you redraw it.
- Create gradients and patterns inside back and front every frame; draw helper canvases the same way every frame.

## Motion
- Slow: a loop of 6 to 12 s; things move a few percent of the canvas per loop.
- Eased: sin/cos drift, breathing scale and alpha, a phase per element; never linear ping-pong.
- Calm near the frame, livelier at the edges.

## Looks cheap: avoid
- Flat solid primitives as the motif (plain circles, squares, triangles).
- Hard-edged clip-art built from basic shapes (cartoon sun, hearts, smiley clouds, emoji-like icons).
- Rainbow or hue-cycling colour, full saturation everywhere.
- Uniform particle spam: hundreds of same-size dots at one speed and alpha.
- Busy patterns, grids, text or stripes behind the frame; 1 px strokes everywhere; large pure black or white areas.

## 3D (three.js)
- Renderer: toneMapping = THREE.ACESFilmicToneMapping (or THREE.AgXToneMapping), outputColorSpace = THREE.SRGBColorSpace, setPixelRatio(1). Colours as new THREE.Color(hex).
- Environment for real reflections, once in setup: const pmrem = new THREE.PMREMGenerator(renderer); world.environment = pmrem.fromScene(new THREE.addons.RoomEnvironment(), 0.04).texture; pmrem.dispose(); plus one DirectionalLight as the key light.
- Materials: MeshPhysicalMaterial. Glossy plastic or ceramic: roughness 0.25-0.45, clearcoat 1, clearcoatRoughness 0.1. Metal: metalness 1, roughness 0.2-0.35. Glass: transmission 1, thickness 0.5-1.5, ior 1.45, roughness 0.05-0.15. Fabric: sheen 1, sheenColor. No MeshBasicMaterial, MeshNormalMaterial or flatShading on a hero object.
- Geometry: rounded and beveled forms with enough segments: new THREE.addons.RoundedBoxGeometry(w, h, d, 6, radius), CapsuleGeometry, TorusGeometry, SphereGeometry(r, 64, 32), LatheGeometry of a smooth profile, ExtrudeGeometry with bevelEnabled. Never a raw BoxGeometry or a low-poly sphere as the subject.
- Grounding: a soft contact shadow under each object (a blurred dark ellipse drawn with ctx before the render, at the object's projected position; with bloom, paint it into the backdrop texture instead). Real shadow maps only with PCFSoftShadowMap and a 1024 map.
- Textures are procedural only: a THREE.CanvasTexture of an OffscreenCanvas you draw, or a DataTexture of seeded data; set colorSpace = THREE.SRGBColorSpace on colour maps.
- Bloom for glowing things: composer = new THREE.addons.EffectComposer(renderer, new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 })); add new THREE.addons.RenderPass(world, camera), new THREE.addons.UnrealBloomPass(new THREE.Vector2(w, h), strength 0.6-1, radius 0.4-0.7, threshold 0.1-0.8), new THREE.addons.OutputPass(); call composer.setSize(w, h) on resize and composer.render() instead of renderer.render. Bloom does not keep transparency: give the three scene an opaque backdrop (world.background = a CanvasTexture gradient) and draw the result over the whole canvas.
- Depth of field: fake it with 2D bokeh in front() (and behind, unless bloom covers the canvas), or draw a far layer blurred.
- Camera: fov 30 to 45; place objects in the margins around scene.frame (project frame corners to world units); float and turn them by whole cycles.
