"""End-to-end: upload a local image → remove its background → wait → print the public URL.

    IMAGESTEP_API_KEY=is_sk_… python examples/remove_bg.py ./photo.jpg
    IMAGESTEP_BASE_URL=http://imagestep-service.localhost  (default https://api.imagestep.dev)
"""
import os
import sys

from imagestep import ImageStep

file = sys.argv[1] if len(sys.argv) > 1 else "./photo.jpg"
client = ImageStep(api_key=os.environ["IMAGESTEP_API_KEY"], base_url=os.environ.get("IMAGESTEP_BASE_URL"))

asset = client.assets.upload(file, collection="examples")
info = asset.get("image") or {}
print("uploaded", asset["id"], f"{info.get('width')}×{info.get('height')}")

estimate = client.ops.estimate("remove_bg", asset_ids=asset["id"])
print("estimate", estimate["estimatedCredits"], "credits for", estimate["totalItems"], "item")

job = client.ops.remove_bg(asset["id"], wait={"on_progress": lambda j: print(" ", j["status"])})
[output] = client.jobs.outputs(job)
[published] = client.assets.publish(output["id"])
print("done →", published["publicUrl"])
