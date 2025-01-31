const {
  passportAuth,
  apiAccessKeyCheckAuth,
} = require('../middleware/passport');
const logger = require('../../lib/logger');

const Logger = logger.getInstance();

module.exports = (Router, Service) => {
  Router.get(
    '/welcome',
    apiAccessKeyCheckAuth(Service),
    passportAuth,
    (req, res) => {
      res.status(200).send({
        file_exists: !!req.user.welcomePack,
        root_folder_id: req.user.root_folder_id,
      });
    }
  );

  Router.delete('/welcome', passportAuth, (req, res) => {
    req.user.welcomePack = false;
    req.user
      .save()
      .then(() => {
        res.status(200).send();
      })
      .catch((err) => {
        Logger.error('Cannot delete welcome files: %s', err.message);
        res.status(500).send({ error: 'Welcome files cannot be deleted' });
      });
  });
};
