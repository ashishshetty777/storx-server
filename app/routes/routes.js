const sgMail = require("@sendgrid/mail");
const speakeasy = require("speakeasy");
const uuid = require("uuid");
const Analytics = require("analytics-node");
const analytics = new Analytics(process.env.APP_SEGMENT_KEY);
const openpgp = require("openpgp");
const ActivationRoutes = require("./activation");
const StorageRoutes = require("./storage");
const BridgeRoutes = require("./bridge");
const StripeRoutes = require("./stripe");
const DesktopRoutes = require("./desktop");
const MobileRoutes = require("./mobile");
const TwoFactorRoutes = require("./twofactor");
const ExtraRoutes = require("./extra");
const AppSumoRoutes = require("./appsumo");
const PhotosRoutes = require("./photos");
const passport = require("../middleware/passport");
const TeamsRoutes = require("./teams");
const logger = require("../../lib/logger");
const moment = require("moment");
const AesUtil = require("../../lib/AesUtil");
const CryptoJS = require("crypto-js");

const { passportAuth } = passport;

const Logger = logger.getInstance();

module.exports = (Router, Service, App) => {
  // User account activation/deactivation
  ActivationRoutes(Router, Service, App);
  // Files/folders operations
  StorageRoutes(Router, Service, App);
  // Calls to the BRIDGE api
  BridgeRoutes(Router, Service, App);
  // Calls to STRIPE api
  StripeRoutes(Router, Service, App);
  // Routes used by X-Cloud-Desktop
  DesktopRoutes(Router, Service, App);
  // Routes used by X-Cloud-Mobile
  MobileRoutes(Router, Service, App);
  // Routes to create, edit and delete the 2-factor-authentication
  TwoFactorRoutes(Router, Service, App);
  // Extra routes uncategorized
  ExtraRoutes(Router, Service, App);
  // Teams routes
  TeamsRoutes(Router, Service, App);
  // AppSumo routes
  AppSumoRoutes(Router, Service, App);
  // Routes used by Storx Photos
  PhotosRoutes(Router, Service, App);

  Router.post("/login", (req, res) => {
    if (!req.body.email) {
      return res.status(400).send({ error: "No email address specified" });
    }

    try {
      req.body.email = req.body.email.toLowerCase();
    } catch (e) {
      return res.status(400).send({ error: "Invalid username" });
    }

    // Call user service to find user
    return Service.User.FindUserByEmail(req.body.email)
      .then((userData) => {
        if (!userData) {
          // Wrong user
          return res.status(400).json({ error: "Wrong email/password" });
        }

        return Service.Storj.IsUserActivated(req.body.email)
          .then((resActivation) => {
            if (!resActivation.data.activated) {
              res.status(400).send({ error: "User is not activated" });
            } else {
              const encSalt = App.services.Crypt.encryptText(
                userData.hKey.toString()
              );
              const required2FA =
                userData.secret_2FA && userData.secret_2FA.length > 0;
              Service.KeyServer.keysExists(userData).then((keyExist) => {
                res
                  .status(200)
                  .send({ hasKeys: keyExist, sKey: encSalt, tfa: required2FA });
              });
            }
          })
          .catch((err) => {
            res.status(400).send({
              error: "User not found on Bridge database",
              message: err.response ? err.response.data : err,
            });
          });
      })
      .catch((err) => {
        Logger.error(`${err}: ${req.body.email}`);
        res.status(400).send({
          error: "User not found on Cloud database",
          message: err.message,
        });
      });
  });

  Router.post("/test-access-key", passportAuth, (req, res) => {
    const { user } = req;
    return Service.User.GenerateTestApplicationKey(user)
      .then((keyData) => {
        res.status(200).send({ testApplicationKey: keyData });
      })
      .catch((err) => {
        res.status(400).send({
          error: "Error generating test key",
          message: err.message,
        });
      });
  });

  Router.post("/live-access-key", passportAuth, (req, res) => {
    const { user } = req;
    return Service.User.GenerateLiveApplicationKey(user)
      .then((keyData) => {
        res.status(200).send({ liveApplicationKey: keyData });
      })
      .catch((err) => {
        res.status(400).send({
          error: "Error generating live key",
          message: err.message,
        });
      });
  });

  Router.post("/access", (req, res) => {
    const MAX_LOGIN_FAIL_ATTEMPTS = 5;

    // Call user service to find or create user
    Service.User.FindUserByEmail(req.body.email)
      .then(async (userData) => {
        if (userData.errorLoginCount >= MAX_LOGIN_FAIL_ATTEMPTS) {
          return res.status(500).send({
            error:
              "Your account has been blocked for security reasons. Please reach out to us",
          });
        }

        if (userData.registerCompleted == false) {
          return res.status(400).send({ error: "Please verify your email" });
        }

        // Process user data and answer API call
        const pass = App.services.Crypt.decryptText(req.body.password);
        // 2-Factor Auth. Verification
        const needsTfa = userData.secret_2FA && userData.secret_2FA.length > 0;
        let tfaResult = true;
        if (needsTfa) {
          tfaResult = speakeasy.totp.verifyDelta({
            secret: userData.secret_2FA,
            token: req.body.tfa,
            encoding: "base32",
            window: 2,
          });
        }
        if (!tfaResult) {
          return res.status(400).send({ error: "Wrong 2-factor auth code" });
        }

        if (pass === userData.password.toString() && tfaResult) {
          // Successfull login
          const internxtClient = req.headers["storx-client"];
          const token = passport.Sign(
            userData.email,
            App.config.get("secrets").JWT,
            internxtClient === "drive-web"
          );

          Service.User.LoginFailed(req.body.email, false);
          Service.User.UpdateAccountActivity(req.body.email);
          const userBucket = await Service.User.GetUserBucket(userData);

          const keyExists = await Service.KeyServer.keysExists(userData);

          if (!keyExists && req.body.publicKey) {
            await Service.KeyServer.addKeysLogin(
              userData,
              req.body.publicKey,
              req.body.privateKey,
              req.body.revocateKey
            );
          }

          const keys = await Service.KeyServer.getKeys(userData);
          const hasTeams = !!(await Service.Team.getTeamByMember(
            req.body.email
          ));

          const user = {
            email: req.body.email,
            userId: userData.userId,
            mnemonic: userData.mnemonic,
            root_folder_id: userData.root_folder_id,
            name: userData.name,
            lastname: userData.lastname,
            uuid: userData.uuid,
            credit: userData.credit,
            createdAt: userData.createdAt,
            privateKey: keys ? keys.private_key : null,
            publicKey: keys ? keys.public_key : null,
            revocateKey: keys ? keys.revocation_key : null,
            bucket: userBucket,
            registerCompleted: userData.registerCompleted,
            testApplicationKey: userData.testApplicationKey,
            liveApplicationKey: userData.liveApplicationKey,
            teams: hasTeams,
          };

          const userTeam = null;
          if (userTeam) {
            const tokenTeam = passport.Sign(
              userTeam.bridge_user,
              App.config.get("secrets").JWT,
              internxtClient === "drive-web"
            );
            return res.status(200).json({
              user,
              token,
              userTeam,
              tokenTeam,
            });
          }
          return res.status(200).json({ user, token, userTeam });
        }
        // Wrong password
        if (pass !== userData.password.toString()) {
          Service.User.LoginFailed(req.body.email, true);
        }

        return res.status(400).json({ error: "Wrong email/password" });
      })
      .catch((err) => {
        Logger.error(`${err.message}\n${err.stack}`);
        return res.status(400).send({
          error: "User not found on Cloud database",
          message: err.message,
        });
      });
  });

  Router.post("/access_core", (req, res) => {
    const MAX_LOGIN_FAIL_ATTEMPTS = 5;

    // Call user service to find or create user
    Service.User.FindUserByEmail(req.body.email)
      .then(async (userData) => {
        if (userData.errorLoginCount >= MAX_LOGIN_FAIL_ATTEMPTS) {
          return res.status(500).send({
            error:
              "Your account has been blocked for security reasons. Please reach out to us",
          });
        }

        if (userData.registerCompleted == false) {
          return res.status(400).send({ error: "Please verify your email" });
        }
        //Creating the Vector Key, this will come from env.REACT_APP_MAGIC_IV
        var iv = CryptoJS.enc.Hex.parse(process.env.MAGIC_IV);
        //Encoding the Password in from UTF8 to byte array, this will we use env.APP_SEGMENT_KEY
        var Pass = CryptoJS.enc.Utf8.parse(process.env.APP_SEGMENT_KEY);
        //Encoding the Salt in from UTF8 to byte array, this will come from env.MAGIC_SALT
        var Salt = CryptoJS.enc.Utf8.parse(process.env.MAGIC_SALT);
        //Creating the key in PBKDF2 format to be used during the decryption
        var key128Bits1000Iterations = CryptoJS.PBKDF2(
          Pass.toString(CryptoJS.enc.Utf8),
          Salt,
          { keySize: 128 / 32, iterations: 1000 }
        );
        //Enclosing the test to be decrypted in a CipherParams object as supported by the CryptoJS libarary, this will come from body.password
        var cipherParams = CryptoJS.lib.CipherParams.create({
          ciphertext: CryptoJS.enc.Hex.parse(req.body.password),
        });

        //Decrypting the string contained in cipherParams using the PBKDF2 key
        var decrypted = CryptoJS.AES.decrypt(
          cipherParams,
          key128Bits1000Iterations,
          { mode: CryptoJS.mode.CBC, iv: iv, padding: CryptoJS.pad.Pkcs7 }
        );

        const salt = AesUtil.decryptText(req.body.sKey);
        const hashObj = AesUtil.passToHash({
          password: decrypted.toString(CryptoJS.enc.Utf8),
          salt,
        });
        const encPass = AesUtil.encryptText(hashObj.hash);
        // console.log("decrypted.toString(CryptoJS.enc.Utf8)",decrypted.toString(CryptoJS.enc.Utf8));
        // Process user data and answer API call
        const pass = App.services.Crypt.decryptText(encPass);
        // 2-Factor Auth. Verification
        const needsTfa = userData.secret_2FA && userData.secret_2FA.length > 0;
        let tfaResult = true;
        if (needsTfa) {
          tfaResult = speakeasy.totp.verifyDelta({
            secret: userData.secret_2FA,
            token: req.body.tfa,
            encoding: "base32",
            window: 2,
          });
        }
        if (!tfaResult) {
          return res.status(400).send({ error: "Wrong 2-factor auth code" });
        }

        if (pass === userData.password.toString() && tfaResult) {
          // Successfull login
          const internxtClient = req.headers["storx-client"];
          const token = passport.Sign(
            userData.email,
            App.config.get("secrets").JWT,
            internxtClient === "drive-web"
          );

          Service.User.LoginFailed(req.body.email, false);
          Service.User.UpdateAccountActivity(req.body.email);
          const userBucket = await Service.User.GetUserBucket(userData);

          const keyExists = await Service.KeyServer.keysExists(userData);

          if (!keyExists && req.body.publicKey) {
            await Service.KeyServer.addKeysLogin(
              userData,
              req.body.publicKey,
              req.body.privateKey,
              req.body.revocateKey
            );
          }

          const keys = await Service.KeyServer.getKeys(userData);
          const hasTeams = !!(await Service.Team.getTeamByMember(
            req.body.email
          ));

          const user = {
            email: req.body.email,
            userId: userData.userId,
            mnemonic: userData.mnemonic,
            root_folder_id: userData.root_folder_id,
            name: userData.name,
            lastname: userData.lastname,
            uuid: userData.uuid,
            credit: userData.credit,
            createdAt: userData.createdAt,
            privateKey: keys ? keys.private_key : null,
            publicKey: keys ? keys.public_key : null,
            revocateKey: keys ? keys.revocation_key : null,
            bucket: userBucket,
            registerCompleted: userData.registerCompleted,
            teams: hasTeams,
          };

          const userTeam = null;
          if (userTeam) {
            const tokenTeam = passport.Sign(
              userTeam.bridge_user,
              App.config.get("secrets").JWT,
              internxtClient === "drive-web"
            );
            return res.status(200).json({
              user,
              token,
              userTeam,
              tokenTeam,
            });
          }
          return res.status(200).json({ user, token, userTeam });
        }
        // Wrong password
        if (pass !== userData.password.toString()) {
          Service.User.LoginFailed(req.body.email, true);
        }

        return res.status(400).json({ error: "Wrong email/password" });
      })
      .catch((err) => {
        Logger.error(`${err.message}\n${err.stack}`);
        return res.status(400).send({
          error: "User not found on Cloud database",
          message: err.message,
        });
      });
  });

  Router.get("/user/refresh", passportAuth, async (req, res) => {
    const userData = req.user;

    const keyExists = await Service.KeyServer.keysExists(userData);

    if (!keyExists && req.body.publicKey) {
      await Service.KeyServer.addKeysLogin(
        userData,
        req.body.publicKey,
        req.body.privateKey,
        req.body.revocateKey
      );
    }

    const keys = await Service.KeyServer.getKeys(userData);
    const userBucket = await Service.User.GetUserBucket(userData);

    const internxtClient = req.headers["storx-client"];
    const token = passport.Sign(
      userData.email,
      App.config.get("secrets").JWT,
      internxtClient === "x-cloud-web" || internxtClient === "drive-web"
    );

    const user = {
      userId: userData.userId,
      mnemonic: userData.mnemonic,
      root_folder_id: userData.root_folder_id,
      name: userData.name,
      lastname: userData.lastname,
      uuid: userData.uuid,
      credit: userData.credit,
      createdAt: userData.createdAt,
      privateKey: keys ? keys.private_key : null,
      publicKey: keys ? keys.public_key : null,
      revocateKey: keys ? keys.revocation_key : null,
      bucket: userBucket,
    };
    res.status(200).json({
      user,
      token,
    });
  });

  Router.post("/register", async (req, res) => {
    // Data validation for process only request with all data
    if (req.body.email && req.body.password) {
      req.body.email = req.body.email.toLowerCase().trim();
      Logger.warn(
        "Register request for %s from %s",
        req.body.email,
        req.headers["x-forwarded-for"].split(",")[0]
      );

      let newUser = req.body;

      const { referral } = req.body;
      let hasReferral = false;
      let referrer = null;
      try {
        let existingUser = await Service.User.FindUserByEmail(req.body.email);
        if (existingUser) {
          return res.status(400).send({ message: "User already exists" });
        }
      } catch (e) {}

      // Call user service to find or create user
      const userData = await Service.User.FindOrCreate(newUser);

      if (!userData) {
        return res.status(500).send({ error: "" });
      }

      if (referral != "undefined") {
        await Service.User.FindUserByUuid(referral)
          .then((referalUser) => {
            if (referalUser) {
              newUser.credit = 10;
              hasReferral = true;
              referrer = referalUser;
              Service.User.UpdateCredit(referral);
              Service.User.UpdateCredit(userData.dataValues.uuid);
            }
          })
          .catch(() => {});

        if (hasReferral) {
          Service.Analytics.identify({
            userId: userData.uuid,
            traits: { referred_by: referrer.uuid },
          });
        }

        // Successfull register
        const token = passport.Sign(
          userData.email,
          App.config.get("secrets").JWT
        );

        const user = {
          userId: userData.userId,
          mnemonic: userData.mnemonic,
          root_folder_id: userData.root_folder_id,
          name: userData.name,
          lastname: userData.lastname,
          uuid: userData.uuid,
          credit: userData.credit,
          createdAt: userData.createdAt,
          registerCompleted: userData.registerCompleted,
          email: userData.email,
        };

        try {
          const keys = await Service.KeyServer.getKeys(userData);
          user.privateKey = keys.private_key;
          user.publicKey = keys.public_key;
          user.revocationKey = keys.revocation_key;
        } catch (e) {
          // no op
        }

        return res.status(200).send({ token, user, uuid: userData.uuid });
      }
      // This account already exists
      return res.status(200).send({ message: "Please check mail" });
    }
    return res
      .status(400)
      .send({ message: "You must provide registration data" });
  });

  Router.post("/initialize", (req, res) => {
    // Call user service to find or create user
    Service.User.InitializeUser(req.body)
      .then(async (userData) => {
        // Process user data and answer API call
        if (userData.root_folder_id) {
          // Successfull initialization
          const user = {
            email: userData.email,
            mnemonic: userData.mnemonic,
            root_folder_id: userData.root_folder_id,
          };

          try {
            const familyFolder = await Service.Folder.Create(
              userData,
              "Business",
              user.root_folder_id
            );
            const personalFolder = await Service.Folder.Create(
              userData,
              "Personal",
              user.root_folder_id
            );
            personalFolder.iconId = 1;
            personalFolder.color = "pink";
            familyFolder.iconId = 18;
            familyFolder.color = "yellow";
            await personalFolder.save();
            await familyFolder.save();
          } catch (e) {
            Logger.error("Cannot initialize welcome folders: %s", e.message);
          } finally {
            res.status(200).send({ user });
          }
        } else {
          // User initialization unsuccessful
          res
            .status(400)
            .send({ message: "Your account can't be initialized" });
        }
      })
      .catch((err) => {
        Logger.error(`${err.message}\n${err.stack}`);
        res.send(err.message);
      });
  });

  Router.patch("/user/password", passportAuth, (req, res) => {
    const currentPassword = App.services.Crypt.decryptText(
      req.body.currentPassword
    );
    const newPassword = App.services.Crypt.decryptText(req.body.newPassword);
    const newSalt = App.services.Crypt.decryptText(req.body.newSalt);
    const { mnemonic, privateKey } = req.body;

    Service.User.UpdatePasswordMnemonic(
      req.user,
      currentPassword,
      newPassword,
      newSalt,
      mnemonic,
      privateKey
    )
      .then(() => {
        res.status(200).send({});
      })
      .catch((err) => {
        res.status(500).send({ error: err.message });
      });
  });

  Router.post("/user/claim", passportAuth, (req, res) => {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    const msg = {
      to: "support@storx.tech",
      from: "support@storx.tech",
      subject: "New credit request",
      text: `Hello StorX! I am ready to receive my credit for referring friends. My email is ${req.user.email}`,
    };
    if (req.user.credit > 0) {
      analytics.track({
        userId: req.user.uuid,
        event: "user-referral-claim",
        properties: { credit: req.user.credit },
      });
      sgMail
        .send(msg)
        .then(() => {
          res.status(200).send({});
        })
        .catch((err) => {
          res.status(500).send(err);
        });
    } else {
      res.status(500).send({ error: "No credit" });
    }
  });

  Router.post("/user/invite", passportAuth, (req, res) => {
    const { email } = req.body;

    Service.User.FindUserObjByEmail(email)
      .then((user) => {
        if (user === null) {
          Service.Mail.sendInvitationMail(email, req.user)
            .then(() => {
              Logger.info(
                "User %s send invitation to %s",
                req.user.email,
                req.body.email
              );
              res.status(200).send({});
            })
            .catch((e) => {
              Logger.error(
                "Error: Send mail from %s to %s",
                req.user.email,
                req.body.email
              );
              res.status(200).send({});
            });
        } else {
          Logger.warn(
            "Error: Send mail from %s to %s, already registered",
            req.user.email,
            req.body.email
          );
          res.status(200).send({});
        }
      })
      .catch((err) => {
        Logger.error(
          "Error: Send mail from %s to %s, SMTP error",
          req.user.email,
          req.body.email,
          err.message
        );
        res.status(200).send({});
      });
  });

  Router.get("/user/credit", passportAuth, (req, res) => {
    const { user } = req;
    return res.status(200).send({ userCredit: user.credit });
  });

  Router.get("/user/keys/:email", passportAuth, async (req, res) => {
    const { email } = req.params;

    const user = await Service.User.FindUserByEmail(email).catch(() => null);

    if (user) {
      const existsKeys = await Service.KeyServer.keysExists(user);
      if (existsKeys) {
        const keys = await Service.KeyServer.getKeys(user);
        res.status(200).send({ publicKey: keys.public_key });
      } else {
        res.status(400).send({ error: "This user cannot be invited" });
      }
    } else {
      const { publicKeyArmored } = await openpgp.generateKey({
        userIds: [{ email: "inxt@inxt.com" }],
        curve: "ed25519",
      });
      const codpublicKey = Buffer.from(publicKeyArmored).toString("base64");
      res.status(200).send({ publicKey: codpublicKey });
    }
  });

  return Router;
};
