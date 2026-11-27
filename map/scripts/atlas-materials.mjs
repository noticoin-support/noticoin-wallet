// The desktop atlas packs a wall and a roof into each 2:1 extrusion pattern.
// Keep the MapLibre bundle shared with the public map and adapt only the atlas shaders.
export function withAtlasMaterials(bundle) {
 const replaceShader = (before, after) => {
  const first = bundle.indexOf(before);
  if (first < 0 || bundle.indexOf(before, first + before.length) >= 0)
   throw new Error('Could not locate the MapLibre building pattern shader');
  bundle = bundle.slice(0, first) + after + bundle.slice(first + before.length);
 };
 const vertexOutputs = 'out vec2 v_pos_a;out vec2 v_pos_b;out vec4 v_lighting;';
 replaceShader(vertexOutputs, vertexOutputs + 'flat out float v_atlas_roof;');
 replaceShader(
  String.raw`vec2 pos=normal.x==1.0 && normal.y==0.0 && normal.z==16384.0\n? a_pos\n: vec2(edgedistance,elevation*u_height_factor);`,
  [
   'bool roof = normal.x == 1.0 && normal.y == 0.0 && normal.z == 16384.0;',
   'v_atlas_roof = roof ? 1.0 : 0.0;',
   'if (abs(display_size_a.x - 2.0 * display_size_a.y) < 0.125) display_size_a.x *= 0.5;',
   'if (abs(display_size_b.x - 2.0 * display_size_b.y) < 0.125) display_size_b.x *= 0.5;',
   'vec2 pos = roof ? a_pos : vec2(edgedistance, elevation * u_height_factor);'
  ].join('\\n')
 );
 const fragmentInputs = 'in vec2 v_pos_a;in vec2 v_pos_b;in vec4 v_lighting;';
 replaceShader(fragmentInputs, fragmentInputs + [
  'flat in float v_atlas_roof;',
  'vec2 atlasPatternUV(vec2 tl, vec2 br, vec2 uv) {',
  '    vec2 size = br - tl;',
  '    // Pattern bounds are interpolated varyings on data-driven layers.',
  '    if (size.y > 0.0 && abs(size.x - 2.0 * size.y) < 0.5) {',
  '        size.x *= 0.5;',
  '        tl.x += v_atlas_roof * size.x;',
  '        // Clamp to texel centers to keep wall pixels from bleeding into the roof.',
  '        return (tl + clamp(uv * size, vec2(0.5), size - vec2(0.5))) / u_texsize;',
  '    }',
  '    return mix(tl, br, uv) / u_texsize;',
  '}'
 ].join('\\n'));
 replaceShader(
  'vec2 pos=mix(pattern_tl_a/u_texsize,pattern_br_a/u_texsize,imagecoord);vec4 color1=texture(u_image,pos);vec2 imagecoord_b=mod(v_pos_b,1.0);vec2 pos2=mix(pattern_tl_b/u_texsize,pattern_br_b/u_texsize,imagecoord_b);vec4 color2=texture(u_image,pos2);vec4 mixedColor=mix(color1,color2,u_fade);fragColor=mixedColor*v_lighting;',
  [
   'vec2 pos = atlasPatternUV(pattern_tl_a, pattern_br_a, imagecoord);',
   'vec4 color1 = texture(u_image, pos);',
   'vec2 imagecoord_b = mod(v_pos_b, 1.0);',
   'vec2 pos2 = atlasPatternUV(pattern_tl_b, pattern_br_b, imagecoord_b);',
   'vec4 color2 = texture(u_image, pos2);',
   'fragColor = mix(color1, color2, u_fade) * v_lighting;'
  ].join('\\n')
 );
 return bundle;
}
