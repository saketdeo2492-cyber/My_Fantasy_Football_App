module.exports = async (req, res) => {
  const header = req.headers.cookie || '';
  const hasCookie = header.split(';').map((c) => c.trim()).some((c) => c.startsWith('sw_fpl='));
  res.status(200).json({ loggedIn: hasCookie });
};
