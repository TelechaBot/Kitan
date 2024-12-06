import uuid

print(uuid.uuid4().int & (1 << 24) - 1)
