Certificados de prueba **autofirmados** para los tests de firma digital
(`sign.test.ts`). No sirven para nada fuera de los tests. Contraseña: `secreto`.

- `prueba-rsa.p12`: clave RSA 2048 (PBES2/AES, el formato actual de OpenSSL 3).
- `prueba-ec.p12`: clave de curva elíptica P-256, que ytaPDF todavía no admite.
