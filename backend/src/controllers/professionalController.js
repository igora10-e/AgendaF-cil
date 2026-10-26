import { requireProfessional } from '../models/auth.js';
import * as model from '../models/professional.js';
import { createBooking } from '../models/booking.js';
import { transaction } from '../config/database.js';
import { positiveId } from '../config/errors.js';
import { validDay } from '../config/time.js';
import {
  validateProfile,
  validateService,
  validateSchedule,
  validateBlock,
  validateBooking,
  validateStatus,
} from '../config/validation.js';

export function createProfessionalController({ db, clock }) {
  const pro = (req) => requireProfessional(db, req);
  const optionalDay = (value) => (value === undefined ? undefined : validDay(value));
  return {
    updateProfile: (req, res) =>
      res.json(model.updateProfile(db, pro(req), validateProfile(req.body))),
    services: (req, res) => res.json(model.listServices(db, pro(req))),
    addService: (req, res) =>
      res.status(201).json(model.addService(db, pro(req), validateService(req.body))),
    editService: (req, res) =>
      res.json(
        model.editService(db, pro(req), positiveId(req.params.id), validateService(req.body)),
      ),
    deleteService: (req, res) =>
      res.json(model.deleteService(db, pro(req), positiveId(req.params.id))),
    saveSchedule: (req, res) =>
      res.json(model.saveSchedule(db, pro(req), validateSchedule(req.body).days, clock)),
    blocks: (req, res) => res.json(model.listBlocks(db, pro(req), clock)),
    addBlock: (req, res) =>
      res.status(201).json(model.addBlock(db, pro(req), validateBlock(req.body), clock)),
    removeBlock: (req, res) => res.json(model.removeBlock(db, pro(req), positiveId(req.params.id))),
    appointments: (req, res) =>
      res.json(
        model.listAppointments(
          db,
          pro(req),
          optionalDay(req.query.start),
          optionalDay(req.query.end),
        ),
      ),
    addAppointment: (req, res) => {
      const p = pro(req),
        data = validateBooking(req.body);
      res.status(201).json(transaction(db, () => createBooking(db, p, data, { clock })));
    },
    changeStatus: (req, res) =>
      res.json(
        model.changeStatus(
          db,
          pro(req),
          positiveId(req.params.id),
          validateStatus(req.body).status,
          clock,
        ),
      ),
    clients: (req, res) => res.json(model.listClients(db, pro(req))),
    clientHistory: (req, res) =>
      res.json(model.clientHistory(db, pro(req), positiveId(req.params.id))),
    reports: (req, res) =>
      res.json(model.reports(db, pro(req), validDay(req.query.start), validDay(req.query.end))),
    notifications: (req, res) => res.json(model.notifications(db, pro(req))),
  };
}
