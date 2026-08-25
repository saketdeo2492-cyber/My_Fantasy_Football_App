module.exports = async (req, res) => {
  res.setHeader('Set-Cookie', 'sw_fpl=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
  res.status(200).json({ ok: true });
};
