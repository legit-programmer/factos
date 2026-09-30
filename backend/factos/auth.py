import asyncio
import hashlib
import secrets
import time
from collections import defaultdict, deque

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from .db import uid

COOKIE = "factos_login"


class Auth:
    def __init__(self, db):
        self.db = db
        self.hasher = PasswordHasher()
        self.dummy = self.hasher.hash(secrets.token_hex(32))
        self.attempts = defaultdict(deque)
        self.hash_slots = asyncio.Semaphore(2)

    @staticmethod
    def normalize(email):
        # Deliberately case-insensitive login identifiers, with no provider-specific alias rewriting.
        return str(email).strip().casefold()

    def rate_limit(self, ip, email):
        now = time.monotonic()
        # Bound limiter state; expiry is independent of client-controlled identifiers.
        for key in list(self.attempts):
            if not self.attempts[key] or now - self.attempts[key][-1] >= 300:
                del self.attempts[key]
        if len(self.attempts) > 10000:
            raise ValueError("busy")
        keys = [("ip", ip), ("email", self.normalize(email))]
        for key in keys:
            queue = self.attempts[key]
            while queue and queue[0] < now - 300:
                queue.popleft()
            if len(queue) >= (20 if key[0] == "ip" else 10):
                raise ValueError("rate_limit")
        for key in keys:
            self.attempts[key].append(now)

    async def password_hash(self, password):
        async with self.hash_slots:
            return await asyncio.to_thread(self.hasher.hash, password)

    async def verify(self, email, password):
        user = self.db.one("SELECT * FROM users WHERE email=?", (self.normalize(email),))
        async with self.hash_slots:
            try:
                await asyncio.to_thread(
                    self.hasher.verify, user["password"] if user else self.dummy, password
                )
            except (VerificationError, InvalidHashError):
                return None
            if not user:
                return None
            if self.hasher.check_needs_rehash(user["password"]):
                value = await asyncio.to_thread(self.hasher.hash, password)
                self.db.execute("UPDATE users SET password=? WHERE id=?", (value, user["id"]))
        return user

    def login(self, user_id):
        token = secrets.token_urlsafe(32)
        self.db.execute(
            "INSERT INTO auth_sessions VALUES(?,?,?)",
            (self.token_hash(token), user_id, time.time() + 7 * 86400),
        )
        return token

    @staticmethod
    def token_hash(token):
        return hashlib.sha256(token.encode()).hexdigest()

    def resolve(self, token):
        if not token:
            return None
        return self.db.one(
            "SELECT a.*,u.email FROM auth_sessions a JOIN users u ON u.id=a.user_id "
            "WHERE token_hash=? AND expires>?",
            (self.token_hash(token), time.time()),
        )

    async def register(self, email, password):
        value = await self.password_hash(password)
        user_id = uid("user")
        self.db.execute("INSERT INTO users VALUES(?,?,?)", (user_id, self.normalize(email), value))
        return user_id
