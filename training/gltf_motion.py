"""Minimal animation-only glTF reader for the attributed local training corpus.

Reads standard embedded buffers and node TRS channels without loading textures,
executing scripts, or modifying the source asset. Not an application importer.
"""
import base64
import json
from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation, Slerp


class GltfMotion:
    def __init__(self, path):
        self.path = Path(path)
        self.data = json.loads(self.path.read_text(encoding='utf-8'))
        self.buffers = []
        for buffer in self.data['buffers']:
            uri = buffer['uri']
            if uri.startswith('data:'):
                self.buffers.append(base64.b64decode(uri.split(',', 1)[1]))
            else:
                location = (self.path.parent / uri).resolve()
                if not location.is_relative_to(self.path.parent.resolve()):
                    raise ValueError('Buffer is outside the source asset directory.')
                self.buffers.append(location.read_bytes())
        self.names = [node.get('name', str(i)) for i, node in enumerate(self.data['nodes'])]
        self.parents = [-1] * len(self.names)
        for parent, node in enumerate(self.data['nodes']):
            for child in node.get('children', []):
                self.parents[child] = parent
        self.order = []
        def visit(index):
            self.order.append(index)
            for child in self.data['nodes'][index].get('children', []):
                visit(child)
        for i, parent in enumerate(self.parents):
            if parent < 0:
                visit(i)
        if len(self.order) != len(self.names):
            raise ValueError('Invalid source hierarchy.')

    def accessor(self, index):
        accessor = self.data['accessors'][index]
        view = self.data['bufferViews'][accessor['bufferView']]
        dtype = {5126: '<f4', 5125: '<u4', 5123: '<u2', 5122: '<i2', 5121: 'u1', 5120: 'i1'}[accessor['componentType']]
        width = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}[accessor['type']]
        stride = view.get('byteStride', width * np.dtype(dtype).itemsize)
        offset = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
        return np.ndarray((accessor['count'], width), dtype=dtype, buffer=self.buffers[view['buffer']],
                          offset=offset, strides=(stride, np.dtype(dtype).itemsize)).copy()

    def local(self, animation=None, fps=20):
        duration = 0 if animation is None else max(float(self.accessor(s['input'])[-1, 0]) for s in animation['samplers'])
        times = np.linspace(0, duration, max(2, int(round(duration * fps)) + 1)) if duration else np.array([0.])
        positions = np.array([[node.get('translation', [0, 0, 0]) for node in self.data['nodes']]], dtype=float).repeat(len(times), axis=0)
        rotations = np.array([[node.get('rotation', [0, 0, 0, 1]) for node in self.data['nodes']]], dtype=float).repeat(len(times), axis=0)
        scales = np.array([[node.get('scale', [1, 1, 1]) for node in self.data['nodes']]], dtype=float).repeat(len(times), axis=0)
        if any('matrix' in node for node in self.data['nodes']):
            raise ValueError('Matrix-only node found; this training reader expects authored TRS nodes.')
        if animation:
            for channel in animation['channels']:
                target = channel['target']
                if target['path'] not in ['translation', 'rotation', 'scale']:
                    continue
                sampler = animation['samplers'][channel['sampler']]
                if sampler.get('interpolation', 'LINEAR') != 'LINEAR':
                    raise ValueError('Training reader expects LINEAR channels.')
                knots = self.accessor(sampler['input'])[:, 0]
                values = self.accessor(sampler['output'])
                query = times.clip(knots[0], knots[-1])
                if target['path'] == 'rotation':
                    rotations[:, target['node']] = Slerp(knots, Rotation.from_quat(values))(query).as_quat()
                else:
                    result = np.stack([np.interp(query, knots, values[:, a]) for a in range(3)], axis=-1)
                    (positions if target['path'] == 'translation' else scales)[:, target['node']] = result
        return times, positions, rotations, scales

    def world(self, animation=None, fps=20):
        times, positions, rotations, scales = self.local(animation, fps)
        world_positions, world_rotations, world_scales = positions.copy(), rotations.copy(), scales.copy()
        for node in self.order:
            parent = self.parents[node]
            if parent < 0:
                continue
            rotation = Rotation.from_quat(world_rotations[:, parent])
            world_positions[:, node] = world_positions[:, parent] + rotation.apply(positions[:, node] * world_scales[:, parent])
            world_rotations[:, node] = (rotation * Rotation.from_quat(rotations[:, node])).as_quat()
            world_scales[:, node] *= world_scales[:, parent]
        return times, world_positions, world_rotations
