"""Render nonclinical 3D test fixtures for the debug-only glasses display lab."""
import math
from pathlib import Path
import bpy
from mathutils import Vector

out = Path(__file__).parent / "app/src/debug/assets/display-lab"
out.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 16
scene.render.resolution_x, scene.render.resolution_y = 320, 220
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.world.use_nodes = True
scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0

def material(name, color):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*color, 1)
    return mat

cyan = material("Cyan test torso", (0.03, 0.65, 0.9))
white = material("White test head", (0.9, 0.9, 0.9))
orange = material("Orange test marker", (1, 0.28, 0.02))

def ellipsoid(name, location, scale, mat):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, location=location)
    obj = bpy.context.object
    obj.name, obj.scale = name, scale
    obj.data.materials.append(mat)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True

ellipsoid("Abstract torso, not anatomical guidance", (0, 0, 0), (0.8, 0.35, 1.0), cyan)
ellipsoid("Head", (0, 0, 1.5), (0.34, 0.3, 0.4), white)
ellipsoid("Visual marker", (0.2, -0.36, 0.25), (0.2, 0.07, 0.2), orange)
for x in (-1, 1):
    ellipsoid("Side", (x, 0, 0), (0.15, 0.2, 0.8), white)
bpy.ops.object.light_add(type="AREA", location=(2, -4, 5))
bpy.context.object.data.energy = 650
bpy.context.object.data.shape = "DISK"
bpy.context.object.data.size = 4
bpy.ops.object.camera_add()
camera = bpy.context.object
camera.data.type = "ORTHO"
camera.data.ortho_scale = 4.4
scene.camera = camera
for index, angle in enumerate((0, 45, 90, 135)):
    theta = math.radians(angle)
    camera.location = (5 * math.sin(theta), -5 * math.cos(theta), 2.5)
    camera.rotation_euler = (Vector((0, 0, 0.45)) - camera.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = str(out / f"view{index}.png")
    bpy.ops.render.render(write_still=True)
